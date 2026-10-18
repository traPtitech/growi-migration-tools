import { createHash } from 'node:crypto';
import { EJSON } from 'bson';
import {
  type ClientSession,
  type Db,
  type MongoClient,
  ObjectId,
} from 'mongodb';
import { convertBody, createUrlResolver, isLegacyKey } from './urls.ts';

export interface FileRef {
  id: string;
  filePath: string;
  fileSize: number;
}
export interface Options {
  wikiOrigin: string;
  swiftBase: string;
  source: string;
  destination: string;
}
export interface Plan {
  version: 1;
  database: string;
  options: Options;
  fingerprint: string;
  files: FileRef[];
  revisions: { id: string; before: string; after: string }[];
  skippedAttachments: number;
}

export async function buildPlan(
  db: Db,
  options: Options,
  session?: ClientSession,
): Promise<Plan> {
  const read = (name: string) =>
    db.collection(name).find({}, { session }).sort({ _id: 1 }).toArray();
  const pages = await read('pages');
  const revisions = await read('revisions');
  const attachments = await read('attachments');
  const fingerprint = createHash('sha256')
    .update(
      EJSON.stringify({ pages, revisions, attachments }, { relaxed: false }),
    )
    .digest('hex');
  const pageIds = new Set(
    pages
      .filter((p) => p._id instanceof ObjectId)
      .map((p) => p._id.toHexString()),
  );
  const duplicateKeys = new Set<string>();
  const seen = new Set<string>();
  for (const a of attachments) {
    if (seen.has(a.filePath)) duplicateKeys.add(a.filePath);
    seen.add(a.filePath);
  }
  const files = attachments
    .filter(
      (a) =>
        a._id instanceof ObjectId &&
        a.page instanceof ObjectId &&
        pageIds.has(a.page.toHexString()) &&
        typeof a.filePath === 'string' &&
        isLegacyKey(a.filePath) &&
        !duplicateKeys.has(a.filePath) &&
        Number.isSafeInteger(a.fileSize) &&
        a.fileSize >= 0,
    )
    .map((a) => ({
      id: a._id.toHexString(),
      filePath: a.filePath as string,
      fileSize: a.fileSize as number,
    }));
  const owners = new Map<string, string[]>();
  for (const p of pages) {
    if (!(p._id instanceof ObjectId) || !(p.revision instanceof ObjectId))
      continue;
    const id = p.revision.toHexString();
    owners.set(id, [...(owners.get(id) ?? []), p._id.toString()]);
  }
  const resolveUrl = createUrlResolver(
    files,
    options.wikiOrigin,
    options.swiftBase,
  );
  const changes: Plan['revisions'] = [];
  for (const r of revisions) {
    if (!(r._id instanceof ObjectId)) continue;
    const ownerIds = owners.get(r._id.toString());
    if (
      ownerIds?.length !== 1 ||
      !(r.pageId instanceof ObjectId) ||
      r.pageId.toHexString() !== ownerIds[0] ||
      typeof r.body !== 'string'
    )
      continue;
    const after = convertBody(r.body, resolveUrl);
    if (after !== r.body)
      changes.push({ id: r._id.toString(), before: r.body, after });
  }
  return {
    version: 1,
    database: db.databaseName,
    options,
    fingerprint,
    files,
    revisions: changes,
    skippedAttachments: attachments.length - files.length,
  };
}

export function assertPlan(actual: Plan, reviewed: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(reviewed))
    throw new Error(
      'Plan does not match the current database and options; create a new dry-run plan',
    );
}

export async function applyBodies(
  client: MongoClient,
  db: Db,
  reviewed: Plan,
  verifiedIds: ReadonlySet<string>,
): Promise<number> {
  const session = client.startSession();
  let count = 0;
  try {
    await session.withTransaction(async () => {
      const current = await buildPlan(db, reviewed.options, session);
      assertPlan(current, reviewed);
      const resolveUrl = createUrlResolver(
        current.files.filter((f) => verifiedIds.has(f.id)),
        current.options.wikiOrigin,
        current.options.swiftBase,
      );
      count = 0;
      for (const revision of current.revisions) {
        const body = convertBody(revision.before, resolveUrl);
        if (body === revision.before) continue;
        const result = await db
          .collection('revisions')
          .updateOne(
            { _id: new ObjectId(revision.id), body: revision.before },
            { $set: { body } },
            { session },
          );
        if (result.matchedCount !== 1)
          throw new Error('Revision changed during migration');
        count++;
      }
    });
    return count;
  } finally {
    await session.endSession();
  }
}
