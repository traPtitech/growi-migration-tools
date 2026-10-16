import { createHash } from 'node:crypto';
import { serialize } from 'bson';
import {
  type ClientSession,
  type Db,
  type Document,
  type MongoClient,
  ObjectId,
} from 'mongodb';

export interface PreparationPlan {
  version: 1;
  tool: 'prepare-legacy-migration';
  database: string;
  fingerprint: string;
  dropConfigIndex: boolean;
  pathUpdates: {
    pageId: string;
    from: string;
    to: string;
    revisionIds: string[];
    access: Record<string, unknown>;
  }[];
}

interface Snapshot {
  configs: Document[];
  pages: Document[];
  revisions: Document[];
  indexes: Document[];
}

function digest(value: Record<string, Document[]>): string {
  const hash = createHash('sha256');
  for (const [name, documents] of Object.entries(value)) {
    hash.update(name);
    for (const document of documents) hash.update(serialize(document));
  }
  return hash.digest('hex');
}

async function snapshot(db: Db, session?: ClientSession): Promise<Snapshot> {
  const names = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      (c) => c.name,
    ),
  );
  for (const name of ['configs', 'pages', 'revisions'])
    if (!names.has(name))
      throw new Error(`Required collection is missing: ${name}`);
  if (await db.collection('pageoperations').countDocuments({}, { session }))
    throw new Error('Pending pageoperations must be resolved first');
  const projections = {
    configs: { _id: 1, key: 1 },
    pages: {
      _id: 1,
      path: 1,
      revision: 1,
      redirectTo: 1,
      grant: 1,
      grantedUsers: 1,
      grantedGroup: 1,
      grantedGroups: 1,
    },
    revisions: { _id: 1, path: 1, pageId: 1 },
  };
  const result = {} as Snapshot;
  for (const name of ['configs', 'pages', 'revisions'] as const)
    result[name] = await db
      .collection(name)
      .find({}, { session, projection: projections[name] })
      .sort({ _id: 1 })
      .toArray();
  result.indexes = [];
  for (const name of ['configs', 'pages', 'revisions'])
    result.indexes.push({
      collection: name,
      indexes: (await db.collection(name).indexes()).sort((a, b) =>
        String(a.name).localeCompare(String(b.name)),
      ),
    });
  return result;
}

function configState(data: Snapshot): string {
  return digest({
    configs: data.configs,
    indexes: data.indexes.filter((i) => i.collection === 'configs'),
  });
}

function planSnapshot(db: Db, data: Snapshot): PreparationPlan {
  const keys = new Set<string>();
  for (const config of data.configs) {
    if (typeof config.key !== 'string' || !config.key.length)
      throw new Error('Config keys must be nonempty strings');
    if (keys.has(config.key))
      throw new Error('Duplicate config keys must be resolved first');
    keys.add(config.key);
  }
  const configIndexes = data.indexes.find((i) => i.collection === 'configs')
    ?.indexes as Document[];
  const index = configIndexes.find((i) => i.name === 'key_1');
  if (
    index &&
    (JSON.stringify(index.key) !== JSON.stringify({ key: 1 }) ||
      Object.keys(index).some(
        (k) => !['v', 'ns', 'key', 'name', 'unique', 'background'].includes(k),
      ) ||
      (index.unique !== undefined && typeof index.unique !== 'boolean'))
  )
    throw new Error('Unexpected configs.key_1 definition; inspect it manually');

  const pathUpdates: PreparationPlan['pathUpdates'] = [];
  const paths = new Map<string, Document>();
  for (const page of data.pages) {
    if (typeof page.path !== 'string' || !page.path.length)
      throw new Error('Page paths must be nonempty strings');
    if (paths.has(page.path))
      throw new Error('Duplicate page paths must be resolved first');
    paths.set(page.path, page);
  }
  for (const page of data.pages) {
    if (page.path.startsWith('/')) continue;
    if (
      !(page._id instanceof ObjectId) ||
      !(page.revision instanceof ObjectId) ||
      page.redirectTo != null
    )
      throw new Error('Unsupported page without a leading slash');
    const to = `/${page.path}`;
    if (paths.has(to)) throw new Error('Normalized page path already exists');
    if (data.pages.some((p) => p.redirectTo === page.path))
      throw new Error(
        'An affected path is a redirect destination; inspect it manually',
      );
    if (data.revisions.some((r) => r.path === to))
      throw new Error('Normalized revision path already exists');
    const revisions = data.revisions.filter((r) => r.path === page.path);
    if (!revisions.some((r) => String(r._id) === String(page.revision)))
      throw new Error(
        'Latest revision does not belong to the original page path',
      );
    for (const revision of revisions) {
      if (!(revision._id instanceof ObjectId) || 'pageId' in revision)
        throw new Error('Affected revisions must use the legacy path schema');
      if (
        data.pages.some(
          (p) =>
            String(p._id) !== String(page._id) &&
            String(p.revision) === String(revision._id),
        )
      )
        throw new Error('An affected revision is referenced by another page');
    }
    pathUpdates.push({
      pageId: String(page._id),
      from: page.path,
      to,
      revisionIds: revisions.map((r) => String(r._id)),
      access: Object.fromEntries(
        ['grant', 'grantedUsers', 'grantedGroup', 'grantedGroups']
          .filter((field) => field in page)
          .map((field) => [field, page[field]]),
      ),
    });
  }
  return {
    version: 1,
    tool: 'prepare-legacy-migration',
    database: db.databaseName,
    fingerprint: digest({ ...data }),
    dropConfigIndex: Boolean(index && index.unique !== true),
    pathUpdates,
  };
}

export async function buildPlan(db: Db): Promise<PreparationPlan> {
  return planSnapshot(db, await snapshot(db));
}

export async function applyPlan(
  client: MongoClient,
  db: Db,
  reviewed: Pick<
    PreparationPlan,
    'version' | 'tool' | 'database' | 'fingerprint'
  >,
): Promise<PreparationPlan> {
  if (
    reviewed?.version !== 1 ||
    reviewed.tool !== 'prepare-legacy-migration' ||
    reviewed.database !== db.databaseName
  )
    throw new Error('Plan tool, version or database does not match');
  const session = client.startSession();
  let applied: PreparationPlan | undefined;
  let expectedConfigs: string | undefined;
  try {
    await session.withTransaction(
      async () => {
        const data = await snapshot(db, session);
        const plan = planSnapshot(db, data);
        if (plan.fingerprint !== reviewed.fingerprint)
          throw new Error('Database changed; generate and review a new plan');
        expectedConfigs = configState(data);
        for (const change of plan.pathUpdates) {
          const page = await db
            .collection('pages')
            .updateOne(
              { _id: new ObjectId(change.pageId), path: change.from },
              { $set: { path: change.to } },
              { session },
            );
          if (page.matchedCount !== 1)
            throw new Error('Page update precondition failed');
          const revisions = await db.collection('revisions').updateMany(
            {
              _id: { $in: change.revisionIds.map((id) => new ObjectId(id)) },
              path: change.from,
              pageId: { $exists: false },
            },
            { $set: { path: change.to } },
            { session },
          );
          if (revisions.matchedCount !== change.revisionIds.length)
            throw new Error('Revision update precondition failed');
        }
        applied = plan;
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    if (!applied) throw new Error('Transaction did not complete');
    // Index DDL cannot share the document transaction. A fresh plan resumes a partial run.
    if (applied.dropConfigIndex) {
      try {
        const current = await snapshot(db);
        if (configState(current) !== expectedConfigs)
          throw new Error('Config data or indexes changed');
        await db
          .collection('configs')
          .dropIndex('key_1', { writeConcern: { w: 'majority' } });
      } catch (error) {
        throw new Error(
          'Path updates committed, but index adjustment failed. Stop writers, generate and review a new plan, then retry.',
          { cause: error },
        );
      }
    }
    return applied;
  } finally {
    await session.endSession();
  }
}
