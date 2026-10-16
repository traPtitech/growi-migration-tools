import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { applyPlan, buildPlan } from './index.ts';
import type { Alias } from './types.ts';

const uri = process.env.TEST_MONGO_URI;
describe.skipIf(!uri)('duplicate user migration transaction', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(
    `growi_user_merge_test_${randomUUID().replaceAll('-', '')}`,
  );
  const old = new ObjectId('000000000000000000000001');
  const recent = new ObjectId('000000000000000000000002');
  const page = new ObjectId();
  const revision = new ObjectId();
  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
  });
  beforeEach(async () => {
    await db.dropDatabase();
    await db.collection('users').insertMany([
      {
        _id: old,
        username: 'alice',
        email: 'alice@example.invalid',
        status: 2,
        admin: false,
        name: 'Original',
        password: 'old-password',
      },
      {
        _id: recent,
        username: 'alice',
        email: 'alice@example.invalid',
        status: 2,
        admin: false,
        name: 'alice',
        password: 'other-password',
      },
    ]);
    await db.collection('pages').insertOne({
      _id: page,
      path: '/private',
      grant: 4,
      creator: recent,
      grantedUsers: [old, recent],
      seenUsers: [recent, old],
      liker: [recent],
      revision,
    });
    await db.collection('revisions').insertOne({
      _id: revision,
      page,
      author: recent,
      body: `Keep historical ID ${recent}`,
      createdAt: new Date('2020-01-01Z'),
    });
  });
  it('preserves content and grants, unions account references, deduplicates bookmarks and is idempotent', async () => {
    const original = await db.collection('users').findOne({ _id: old });
    const beforeRevision = await db
      .collection('revisions')
      .findOne({ _id: revision });
    await db
      .collection('comments')
      .insertOne({ creator: recent, comment: 'Original comment' });
    await db
      .collection('attachments')
      .insertOne({ creator: recent, filePath: 'unchanged-key' });
    await db
      .collection('externalaccounts')
      .insertOne({ providerType: 'traq', accountId: 'subject', user: recent });
    await db
      .collection('bookmarks')
      .createIndex({ page: 1, user: 1 }, { unique: true });
    const retained = new ObjectId();
    const duplicate = new ObjectId();
    await db.collection('bookmarks').insertMany([
      { _id: duplicate, page, user: recent },
      { _id: retained, page, user: old },
    ]);
    await db
      .collection('bookmarkfolders')
      .insertOne({ owner: recent, bookmarks: [duplicate, retained] });
    const plan = await buildPlan(db);
    expect(plan.groups).toHaveLength(1);
    expect(await db.collection('users').countDocuments()).toBe(2);
    await applyPlan(client, db, plan);
    expect(await db.collection('users').find({}).toArray()).toEqual([original]);
    expect(await db.collection('pages').findOne({ _id: page })).toMatchObject({
      grant: 4,
      creator: old,
      grantedUsers: [old],
      seenUsers: [old],
      liker: [old],
      revision,
    });
    expect(await db.collection('revisions').findOne({ _id: revision })).toEqual(
      { ...beforeRevision, author: old },
    );
    expect(await db.collection('comments').findOne({})).toMatchObject({
      creator: old,
      comment: 'Original comment',
    });
    expect(await db.collection('attachments').findOne({})).toMatchObject({
      creator: old,
      filePath: 'unchanged-key',
    });
    expect(await db.collection('externalaccounts').findOne({})).toMatchObject({
      user: old,
      accountId: 'subject',
    });
    expect(await db.collection('bookmarks').find({}).toArray()).toEqual([
      { _id: retained, page, user: old },
    ]);
    expect(await db.collection('bookmarkfolders').findOne({})).toMatchObject({
      owner: old,
      bookmarks: [retained],
    });
    const rerun = await buildPlan(db);
    expect(rerun.changes).toEqual([]);
    await applyPlan(client, db, rerun);
    expect((await buildPlan(db)).fingerprint).toBe(rerun.fingerprint);
  });
  it('recovers rehearsal aliases while keeping existing unique user indexes', async () => {
    const aliases: Alias[] = ['username', 'email'].map((field) => ({
      id: String(old),
      field: field === 'username' ? 'username' : 'email',
      original: field === 'username' ? 'alice' : 'alice@example.invalid',
      replacement: `temporary-${field}`,
    }));
    await db
      .collection('users')
      .updateOne(
        { _id: old },
        { $set: { username: 'temporary-username', email: 'temporary-email' } },
      );
    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await applyPlan(client, db, await buildPlan(db, aliases), aliases);
    expect(await db.collection('users').findOne({ _id: old })).toMatchObject({
      username: 'alice',
      email: 'alice@example.invalid',
    });
    expect((await buildPlan(db, aliases)).changes).toEqual([]);
  });
  it('rejects content edits after review and unsupported references without writing', async () => {
    const plan = await buildPlan(db);
    await db
      .collection('revisions')
      .updateOne({ _id: revision }, { $set: { body: 'New content' } });
    await expect(applyPlan(client, db, plan)).rejects.toThrow(
      'Database changed',
    );
    expect(await db.collection('users').countDocuments()).toBe(2);
    expect(
      (await db.collection('pages').findOne({ _id: page }))?.creator,
    ).toEqual(recent);
    await db.collection('unknown').insertOne({ owner: recent });
    await expect(buildPlan(db)).rejects.toThrow('Unsupported user reference');
  });
  it('rolls back users and all references if another unique constraint collides', async () => {
    await db
      .collection('useruisettings')
      .createIndex({ user: 1 }, { unique: true });
    await db
      .collection('useruisettings')
      .insertMany([{ user: old }, { user: recent }]);
    const plan = await buildPlan(db);
    await expect(applyPlan(client, db, plan)).rejects.toThrow(/duplicate key/i);
    expect(await db.collection('users').countDocuments()).toBe(2);
    expect(
      (await db.collection('pages').findOne({ _id: page }))?.creator,
    ).toEqual(recent);
    expect(
      (await db.collection('revisions').findOne({ _id: revision }))?.author,
    ).toEqual(recent);
  });
});
