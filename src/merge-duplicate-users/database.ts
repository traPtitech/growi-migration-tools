import { createHash } from 'node:crypto';
import { serialize } from 'bson';
import {
  type ClientSession,
  type Db,
  type Document,
  type MongoClient,
  ObjectId,
} from 'mongodb';
import {
  assertNoUnknownReferences,
  mappedArray,
  mappedId,
  referenceChanges,
} from './references.ts';
import type { Alias, Change, MergePlan } from './types.ts';
import { normalizeUsers, planUsers } from './users.ts';

async function bookmarkRemovals(
  db: Db,
  mapping: Map<string, string>,
  session?: ClientSession,
): Promise<Map<string, string>> {
  const groups = new Map<string, Document[]>();
  for await (const doc of db.collection('bookmarks').find({}, { session })) {
    const key = `${doc.page}:${mappedId(doc.user, mapping)}`;
    groups.set(key, [...(groups.get(key) ?? []), doc]);
  }
  const removed = new Map<string, string>();
  for (const documents of groups.values()) {
    if (
      documents.length < 2 ||
      !documents.some((d) => mapping.has(String(d.user)))
    )
      continue;
    const sorted = [...documents].sort(
      (a, b) =>
        Number(mapping.has(String(a.user))) -
          Number(mapping.has(String(b.user))) ||
        String(a._id).localeCompare(String(b._id)),
    );
    for (const doc of sorted.slice(1))
      removed.set(String(doc._id), String(sorted[0]._id));
  }
  return removed;
}

export async function buildPlan(
  db: Db,
  aliases: Alias[] = [],
  session?: ClientSession,
): Promise<MergePlan> {
  if (await db.collection('pageoperations').countDocuments({}, { session }))
    throw new Error('Pending pageoperations must be resolved first');
  const stored = await db.collection('users').find({}, { session }).toArray();
  const users = normalizeUsers(stored, aliases);
  const groups = planUsers(users);
  const mapping = new Map(
    groups.flatMap((g) => g.removeIds.map((id) => [id, g.keepId] as const)),
  );
  const removedBookmarks = await bookmarkRemovals(db, mapping, session);
  const normalizedById = new Map(users.map((u) => [String(u._id), u]));
  const keepIds = new Set(groups.map((g) => g.keepId));
  const changes: Change[] = [];
  const referenceUpdates: Record<string, number> = {};
  const fingerprint = createHash('sha256').update(JSON.stringify(aliases));
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();
  for (const collection of names) {
    fingerprint.update(
      JSON.stringify([collection, await db.collection(collection).indexes()]),
    );
    for await (const document of db
      .collection(collection)
      .find({}, { session })
      .sort({ _id: 1 })) {
      fingerprint.update(serialize(document));
      const id = String(document._id);
      if (
        (collection === 'users' && mapping.has(id)) ||
        (collection === 'bookmarks' && removedBookmarks.has(id))
      ) {
        changes.push({ collection, id, delete: true });
        continue;
      }
      const set = referenceChanges(collection, document, mapping);
      if (
        collection === 'bookmarkfolders' &&
        Array.isArray(document.bookmarks)
      ) {
        if (document.bookmarks.some((id) => removedBookmarks.has(String(id))))
          set.bookmarks = mappedArray(document.bookmarks, removedBookmarks);
      }
      if (collection === 'users' && keepIds.has(id)) {
        const normalized = normalizedById.get(id);
        for (const field of ['username', 'email'])
          if (normalized && document[field] !== normalized[field])
            set[field] = normalized[field];
      }
      assertNoUnknownReferences({ ...document, ...set }, mapping, collection);
      assertNoUnknownReferences(
        { ...document, ...set },
        removedBookmarks,
        collection,
      );
      if (
        collection === 'sessions' &&
        typeof document.session === 'string' &&
        [...mapping.keys()].some((key) => document.session.includes(key))
      )
        throw new Error('Affected sessions must be cleared before merging');
      if (Object.keys(set).length) {
        changes.push({ collection, id, set });
        for (const key of Object.keys(set))
          referenceUpdates[`${collection}.${key}`] =
            (referenceUpdates[`${collection}.${key}`] ?? 0) + 1;
      }
    }
  }
  return {
    version: 1,
    database: db.databaseName,
    fingerprint: fingerprint.digest('hex'),
    groups,
    changes,
    referenceUpdates,
  };
}

export async function applyPlan(
  client: MongoClient,
  db: Db,
  reviewed: Pick<MergePlan, 'version' | 'database' | 'fingerprint'>,
  aliases: Alias[] = [],
): Promise<MergePlan> {
  if (reviewed?.version !== 1 || reviewed.database !== db.databaseName)
    throw new Error('Plan version or database does not match');
  const session = client.startSession();
  let applied: MergePlan | undefined;
  try {
    await session.withTransaction(
      async () => {
        const plan = await buildPlan(db, aliases, session);
        if (plan.fingerprint !== reviewed.fingerprint)
          throw new Error('Database changed; generate and review a new plan');
        // Remove duplicate bookmarks before updating their unique (page, user) keys.
        for (const change of plan.changes.filter(
          (c) => c.delete && c.collection !== 'users',
        )) {
          const result = await db
            .collection(change.collection)
            .deleteOne({ _id: new ObjectId(change.id) }, { session });
          if (result.deletedCount !== 1)
            throw new Error('Deletion precondition failed');
        }
        // Free aliased usernames and emails before restoring the canonical account.
        for (const change of plan.changes.filter(
          (c) => c.delete && c.collection === 'users',
        )) {
          const result = await db
            .collection('users')
            .deleteOne({ _id: new ObjectId(change.id) }, { session });
          if (result.deletedCount !== 1)
            throw new Error('User deletion precondition failed');
        }
        for (const change of plan.changes.filter((c) => c.set)) {
          const result = await db
            .collection(change.collection)
            .updateOne(
              { _id: new ObjectId(change.id) },
              { $set: change.set },
              { session },
            );
          if (result.matchedCount !== 1)
            throw new Error('Update precondition failed');
        }
        applied = plan;
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    if (!applied) throw new Error('Transaction did not complete');
    return applied;
  } finally {
    await session.endSession();
  }
}
