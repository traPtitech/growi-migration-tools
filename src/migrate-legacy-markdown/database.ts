import { createHash } from 'node:crypto';
import { EJSON, ObjectId } from 'bson';
import type { ClientSession, Db, MongoClient } from 'mongodb';
import { convertBody } from './markdown.ts';

export interface Plan {
  version: 1;
  database: string;
  fingerprint: string;
  revisions: { id: string; before: string; after: string }[];
}

export async function buildPlan(
  db: Db,
  session?: ClientSession,
): Promise<Plan> {
  const read = (name: string) =>
    db.collection(name).find({}, { session }).sort({ _id: 1 }).toArray();
  const pages = await read('pages');
  const revisions = await read('revisions');
  const fingerprint = createHash('sha256')
    .update(EJSON.stringify({ pages, revisions }, { relaxed: false }))
    .digest('hex');

  const owners = new Map<string, string[]>();
  for (const page of pages) {
    if (!(page._id instanceof ObjectId) || !(page.revision instanceof ObjectId))
      continue;
    const revisionId = page.revision.toHexString();
    owners.set(revisionId, [
      ...(owners.get(revisionId) ?? []),
      page._id.toHexString(),
    ]);
  }

  const changes: Plan['revisions'] = [];
  for (const revision of revisions) {
    if (!(revision._id instanceof ObjectId)) continue;
    const ownerIds = owners.get(revision._id.toHexString());
    if (
      ownerIds?.length !== 1 ||
      !(revision.pageId instanceof ObjectId) ||
      revision.pageId.toHexString() !== ownerIds[0] ||
      typeof revision.body !== 'string'
    )
      continue;
    const after = convertBody(revision.body);
    if (after !== revision.body)
      changes.push({
        id: revision._id.toHexString(),
        before: revision.body,
        after,
      });
  }

  return {
    version: 1,
    database: db.databaseName,
    fingerprint,
    revisions: changes,
  };
}

export function assertPlan(actual: Plan, reviewed: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(reviewed))
    throw new Error(
      'Plan does not match the current database; create a new dry-run plan',
    );
}

export async function applyPlan(
  client: MongoClient,
  db: Db,
  reviewed: Plan,
): Promise<number> {
  const session = client.startSession();
  let updated = 0;
  try {
    await session.withTransaction(async () => {
      const current = await buildPlan(db, session);
      assertPlan(current, reviewed);
      updated = 0;
      for (const revision of current.revisions) {
        const result = await db
          .collection('revisions')
          .updateOne(
            { _id: new ObjectId(revision.id), body: revision.before },
            { $set: { body: revision.after } },
            { session },
          );
        if (result.matchedCount !== 1)
          throw new Error('Revision changed during migration');
        updated++;
      }
    });
    return updated;
  } finally {
    await session.endSession();
  }
}
