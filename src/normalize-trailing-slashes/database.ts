import {
  type ClientSession,
  type Db,
  type MongoClient,
  ObjectId,
} from 'mongodb';

import { buildPlan } from './plan.ts';
import { PAGE_REFERENCES } from './references.ts';
import type { MigrationPlan, PageState, Snapshot } from './types.ts';

type StoredPage = Omit<
  PageState,
  'id' | 'parent' | 'revision' | 'grantedUsers' | 'grantedGroups'
> & {
  _id: ObjectId;
  parent?: ObjectId | null;
  revision?: ObjectId | null;
  grantedUsers?: ObjectId[];
  grantedGroups?: { type?: string; item: ObjectId }[] | null;
};

export async function readSnapshot(
  db: Db,
  session?: ClientSession,
): Promise<Snapshot> {
  const pages = await db
    .collection<StoredPage>('pages')
    .find(
      {},
      {
        session,
        projection: {
          path: 1,
          parent: 1,
          revision: 1,
          isEmpty: 1,
          status: 1,
          grant: 1,
          grantedUsers: 1,
          grantedGroups: 1,
          descendantCount: 1,
        },
      },
    )
    .toArray();
  const redirects = await db
    .collection<{ _id: ObjectId; fromPath: string; toPath: string }>(
      'pageredirects',
    )
    .find({}, { session, projection: { fromPath: 1, toPath: 1 } })
    .toArray();
  const pendingOperations = await db
    .collection('pageoperations')
    .countDocuments({}, { session });
  return {
    pages: pages.map((p) => ({
      id: p._id.toHexString(),
      path: p.path,
      parent: p.parent == null ? p.parent : p.parent.toHexString(),
      revision: p.revision == null ? p.revision : p.revision.toHexString(),
      isEmpty: p.isEmpty,
      status: p.status,
      grant: p.grant,
      grantedUsers: p.grantedUsers?.map((id) => id.toString()),
      grantedGroups: p.grantedGroups?.map((g) => ({
        type: g.type,
        item: g.item.toString(),
      })),
      descendantCount: p.descendantCount,
    })),
    redirects: redirects.map((r) => ({
      id: r._id.toHexString(),
      fromPath: r.fromPath,
      toPath: r.toPath,
    })),
    pendingOperations,
  };
}

async function repointReferences(
  db: Db,
  plan: MigrationPlan,
  session: ClientSession,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const reference of PAGE_REFERENCES) {
    let changed = 0;
    for (const merge of plan.merges.filter((m) => m.removeIds.length > 0)) {
      const result = await db.collection(reference.collection).updateMany(
        {
          ...reference.filter,
          [reference.field]: {
            $in: merge.removeIds.map((id) => new ObjectId(id)),
          },
        },
        { $set: { [reference.field]: new ObjectId(merge.keepId) } },
        { session },
      );
      changed += result.modifiedCount;
    }
    counts[`${reference.collection}.${reference.field}`] = changed;
  }
  return counts;
}

async function updateRedirects(
  db: Db,
  plan: MigrationPlan,
  session: ClientSession,
): Promise<void> {
  for (const redirect of plan.redirectUpdates) {
    await db
      .collection('pageredirects')
      .updateOne(
        { _id: new ObjectId(redirect.id) },
        { $set: { toPath: redirect.toPath } },
        { session },
      );
  }
  for (const alias of plan.aliases) {
    await db
      .collection('revisions')
      .updateMany(
        { path: alias.fromPath },
        { $set: { path: alias.toPath } },
        { session },
      );
    await db
      .collection('pageredirects')
      .insertOne({ ...alias, __v: 0 }, { session });
  }
}

async function updatePages(
  db: Db,
  plan: MigrationPlan,
  session: ClientSession,
): Promise<void> {
  const removedIds = plan.merges
    .flatMap((m) => m.removeIds)
    .map((id) => new ObjectId(id));
  if (removedIds.length > 0) {
    const deleted = await db
      .collection('pages')
      .deleteMany(
        { _id: { $in: removedIds }, isEmpty: true, revision: null },
        { session },
      );
    if (deleted.deletedCount !== removedIds.length)
      throw new Error('Empty-page deletion precondition failed');
  }
  if (plan.pageUpdates.length > 0) {
    const result = await db.collection('pages').bulkWrite(
      plan.pageUpdates.map((p) => ({
        updateOne: {
          filter: { _id: new ObjectId(p.id) },
          update: {
            $set: {
              ...p.set,
              ...(p.set.parent == null
                ? {}
                : { parent: new ObjectId(p.set.parent) }),
            },
          },
        },
      })),
      { session },
    );
    if (result.matchedCount !== plan.pageUpdates.length)
      throw new Error('Page update precondition failed');
  }
}

export async function applyPlan(
  client: MongoClient,
  db: Db,
  reviewed: Pick<MigrationPlan, 'version' | 'database' | 'fingerprint'>,
): Promise<{ plan: MigrationPlan; referenceUpdates: Record<string, number> }> {
  if (reviewed.version !== 1 || reviewed.database !== db.databaseName) {
    throw new Error('Plan version or database does not match');
  }
  const session = client.startSession();
  let result:
    | { plan: MigrationPlan; referenceUpdates: Record<string, number> }
    | undefined;
  try {
    await session.withTransaction(
      async () => {
        const plan = buildPlan(
          await readSnapshot(db, session),
          db.databaseName,
        );
        if (plan.fingerprint !== reviewed.fingerprint)
          throw new Error('Database changed; generate and review a new plan');
        const referenceUpdates = await repointReferences(db, plan, session);
        await updatePages(db, plan, session);
        await updateRedirects(db, plan, session);
        result = { plan, referenceUpdates };
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    if (result == null) throw new Error('Transaction did not complete');
    return result;
  } finally {
    await session.endSession();
  }
}
