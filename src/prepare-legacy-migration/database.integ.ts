import { randomUUID } from 'node:crypto';
import { Collection, MongoClient, ObjectId } from 'mongodb';
import { applyPlan, buildPlan } from './database.ts';

const uri = process.env.TEST_MONGO_URI;
describe.skipIf(!uri)('legacy migration preparation', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(
    `growi_prepare_test_${randomUUID().replaceAll('-', '')}`,
  );
  const page = new ObjectId();
  const revision = new ObjectId();
  const olderRevision = new ObjectId();
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
    await db
      .collection('configs')
      .insertOne({ key: 'example', value: 'unchanged' });
    await db
      .collection('configs')
      .createIndex({ key: 1 }, { background: true });
    await db.collection('pages').insertOne({
      _id: page,
      path: 'legacy',
      revision,
      grant: 4,
      grantedUsers: [new ObjectId()],
      createdAt: new Date('2017-09-01Z'),
    });
    await db.collection('pages').createIndex({ path: 1 }, { unique: true });
    await db.collection('revisions').insertMany([
      {
        _id: revision,
        path: 'legacy',
        body: 'Original latest body',
        author: new ObjectId(),
        createdAt: new Date('2017-09-01Z'),
      },
      { _id: olderRevision, path: 'legacy', body: 'Original older body' },
    ]);
    await db
      .collection('attachments')
      .insertOne({ page, filePath: 'unchanged/key' });
  });

  it('plans without writes, preserves all other data, supports standard path linking and reruns', async () => {
    const originalPage = await db.collection('pages').findOne({ _id: page });
    const originalRevisions = await db
      .collection('revisions')
      .find()
      .sort({ _id: 1 })
      .toArray();
    const attachment = await db.collection('attachments').findOne({});
    const config = await db.collection('configs').findOne({});
    const plan = await buildPlan(db);
    expect(plan.pathUpdates).toEqual([
      {
        pageId: String(page),
        from: 'legacy',
        to: '/legacy',
        revisionIds: originalRevisions.map((r) => String(r._id)),
        access: {
          grant: originalPage?.grant,
          grantedUsers: originalPage?.grantedUsers,
        },
      },
    ]);
    expect(plan.dropConfigIndex).toBe(true);
    expect(await db.collection('pages').findOne({ _id: page })).toEqual(
      originalPage,
    );
    const tampered = { ...plan, pathUpdates: [] };
    await applyPlan(client, db, tampered);
    expect(await db.collection('pages').findOne({ _id: page })).toEqual({
      ...originalPage,
      path: '/legacy',
    });
    expect(
      await db.collection('revisions').find().sort({ _id: 1 }).toArray(),
    ).toEqual(originalRevisions.map((r) => ({ ...r, path: '/legacy' })));
    expect(await db.collection('attachments').findOne({})).toEqual(attachment);
    expect(await db.collection('configs').findOne({})).toEqual(config);
    expect(
      (await db.collection('configs').indexes()).some(
        (i) => i.name === 'key_1',
      ),
    ).toBe(false);
    const rerun = await buildPlan(db);
    expect(rerun.pathUpdates).toEqual([]);
    expect(rerun.dropConfigIndex).toBe(false);
    await applyPlan(client, db, rerun);
    expect((await buildPlan(db)).fingerprint).toBe(rerun.fingerprint);
    // The standard migration can now match all legacy histories by the page path.
    await db
      .collection('revisions')
      .updateMany(
        { path: '/legacy', pageId: { $exists: false } },
        { $set: { pageId: page }, $unset: { path: '' } },
      );
    expect(
      await db.collection('revisions').countDocuments({ pageId: page }),
    ).toBe(2);
  });

  it('preserves an existing unique index', async () => {
    await db.collection('configs').dropIndex('key_1');
    await db.collection('configs').createIndex({ key: 1 }, { unique: true });
    const indexes = await db.collection('configs').indexes();
    const plan = await buildPlan(db);
    expect(plan.dropConfigIndex).toBe(false);
    await applyPlan(client, db, plan);
    expect(await db.collection('configs').indexes()).toEqual(indexes);
  });

  it('rejects duplicate config keys before any changes', async () => {
    await db.collection('configs').insertOne({ key: 'example' });
    await expect(buildPlan(db)).rejects.toThrow('Duplicate config keys');
    expect((await db.collection('pages').findOne({ _id: page }))?.path).toBe(
      'legacy',
    );
    expect(await db.collection('configs').indexExists('key_1')).toBe(true);
  });

  it('rejects unsupported index definitions', async () => {
    await db.collection('configs').dropIndex('key_1');
    await db.collection('configs').createIndex({ key: 1 }, { sparse: true });
    await expect(buildPlan(db)).rejects.toThrow('Unexpected configs.key_1');
  });

  it('rejects page and revision destination collisions and ambiguous ownership', async () => {
    const otherPage = new ObjectId();
    await db.collection('pages').insertOne({ _id: otherPage, path: '/legacy' });
    await expect(buildPlan(db)).rejects.toThrow(
      'Normalized page path already exists',
    );
    await db.collection('pages').deleteOne({ _id: otherPage });
    const otherRevision = new ObjectId();
    await db
      .collection('revisions')
      .insertOne({ _id: otherRevision, path: '/legacy' });
    await expect(buildPlan(db)).rejects.toThrow(
      'Normalized revision path already exists',
    );
    await db.collection('revisions').deleteOne({ _id: otherRevision });
    await db
      .collection('revisions')
      .updateOne({ _id: olderRevision }, { $set: { pageId: otherPage } });
    await expect(buildPlan(db)).rejects.toThrow('legacy path schema');
    await db
      .collection('revisions')
      .updateOne({ _id: olderRevision }, { $unset: { pageId: '' } });
    await db
      .collection('pages')
      .insertOne({ _id: otherPage, path: '/other', revision: olderRevision });
    await expect(buildPlan(db)).rejects.toThrow('referenced by another page');
  });

  it('rejects a missing latest revision and redirect references', async () => {
    await db.collection('revisions').deleteOne({ _id: revision });
    await expect(buildPlan(db)).rejects.toThrow('Latest revision');
    await db
      .collection('revisions')
      .insertOne({ _id: revision, path: 'legacy' });
    await db
      .collection('pages')
      .insertOne({ path: '/redirect', redirectTo: 'legacy' });
    await expect(buildPlan(db)).rejects.toThrow('redirect destination');
  });

  it('rejects stale and foreign plans before changing documents or indexes', async () => {
    const plan = await buildPlan(db);
    await expect(
      applyPlan(client, db, { ...plan, database: 'other' }),
    ).rejects.toThrow('does not match');
    await db
      .collection('pages')
      .updateOne({ _id: page }, { $set: { grant: 1 } });
    await expect(applyPlan(client, db, plan)).rejects.toThrow(
      'Database changed',
    );
    expect((await db.collection('pages').findOne({ _id: page }))?.path).toBe(
      'legacy',
    );
    expect(await db.collection('configs').indexExists('key_1')).toBe(true);
  });

  it('rolls back document updates and retains the index on a write failure', async () => {
    await db.command({
      collMod: 'revisions',
      validator: { path: { $regex: '^[^/]' } },
    });
    const plan = await buildPlan(db);
    await expect(applyPlan(client, db, plan)).rejects.toThrow(/validation/i);
    expect((await db.collection('pages').findOne({ _id: page }))?.path).toBe(
      'legacy',
    );
    expect(
      await db.collection('revisions').countDocuments({ path: 'legacy' }),
    ).toBe(2);
    expect(await db.collection('configs').indexExists('key_1')).toBe(true);
  });

  it('resumes index adjustment with a fresh plan after a partial failure', async () => {
    const plan = await buildPlan(db);
    const drop = vi
      .spyOn(Collection.prototype, 'dropIndex')
      .mockRejectedValueOnce(new Error('Simulated DDL failure'));
    try {
      await expect(applyPlan(client, db, plan)).rejects.toThrow(
        'Path updates committed',
      );
    } finally {
      drop.mockRestore();
    }
    expect((await db.collection('pages').findOne({ _id: page }))?.path).toBe(
      '/legacy',
    );
    expect(await db.collection('configs').indexExists('key_1')).toBe(true);
    await expect(applyPlan(client, db, plan)).rejects.toThrow(
      'Database changed',
    );
    const retry = await buildPlan(db);
    expect(retry.pathUpdates).toEqual([]);
    expect(retry.dropConfigIndex).toBe(true);
    await applyPlan(client, db, retry);
    expect((await buildPlan(db)).dropConfigIndex).toBe(false);
  });
});
