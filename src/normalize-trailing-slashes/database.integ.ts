import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';

import { applyPlan, buildPlan, readSnapshot } from './index.ts';

const collections = [
  'pages',
  'revisions',
  'pageredirects',
  'comments',
  'attachments',
  'bookmarks',
  'pagetagrelations',
  'sharelinks',
  'subscriptions',
  'inappnotifications',
  'pageoperations',
];

const uri = process.env.TEST_MONGO_URI;

describe.skipIf(!uri)('trailing slash migration transaction', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(
    `growi_migration_test_${randomUUID().replaceAll('-', '')}`,
  );

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
  const root = new ObjectId();
  const real = new ObjectId();
  const placeholder = new ObjectId();
  const child = new ObjectId();
  const revision = new ObjectId();
  const user = new ObjectId();

  beforeEach(async () => {
    for (const name of collections) await db.collection(name).deleteMany({});
    await db.collection('pages').insertMany([
      { _id: root, path: '/', parent: null, grant: 1, status: 'published' },
      {
        _id: real,
        path: '/teams/',
        parent: root,
        grant: 1,
        status: 'published',
        revision,
        creator: user,
      },
      {
        _id: placeholder,
        path: '/teams',
        parent: root,
        grant: 1,
        status: 'published',
        isEmpty: true,
      },
      {
        _id: child,
        path: '/teams/child',
        parent: placeholder,
        grant: 1,
        status: 'published',
      },
    ]);
    await db.collection('revisions').insertOne({
      _id: revision,
      pageId: real,
      path: '/teams/',
      body: 'Original body',
      author: user,
      createdAt: new Date('2024-01-02T03:04:05Z'),
    });
    await db
      .collection('pageredirects')
      .insertOne({ fromPath: '/old-teams', toPath: '/teams/' });
  });

  it('preserves content and real IDs, rewrites page references, and can run again without changes', async () => {
    const beforeRevision = await db
      .collection('revisions')
      .findOne({ _id: revision });
    await db
      .collection('comments')
      .insertOne({ page: placeholder, comment: 'comment' });
    await db
      .collection('attachments')
      .insertOne({ page: real, filePath: 'original-object-key' });
    await db.collection('bookmarks').insertOne({ page: placeholder, user });
    await db
      .collection('pagetagrelations')
      .insertOne({ relatedPage: placeholder });
    await db.collection('sharelinks').insertOne({ relatedPage: placeholder });
    await db
      .collection('subscriptions')
      .insertOne({ targetModel: 'Page', target: placeholder });
    await db
      .collection('inappnotifications')
      .insertOne({ targetModel: 'User', target: placeholder });
    const reviewed = buildPlan(await readSnapshot(db), db.databaseName);

    await applyPlan(client, db, reviewed);

    expect(
      await db.collection('pages').findOne({ _id: placeholder }),
    ).toBeNull();
    expect(await db.collection('pages').findOne({ _id: real })).toMatchObject({
      path: '/teams',
      creator: user,
      revision,
      descendantCount: 1,
    });
    expect(
      (await db.collection('pages').findOne({ _id: child }))?.parent,
    ).toEqual(real);
    expect(await db.collection('revisions').findOne({ _id: revision })).toEqual(
      {
        ...beforeRevision,
        path: '/teams',
      },
    );
    expect((await db.collection('attachments').findOne({}))?.filePath).toBe(
      'original-object-key',
    );
    expect((await db.collection('comments').findOne({}))?.page).toEqual(real);
    expect((await db.collection('bookmarks').findOne({}))?.page).toEqual(real);
    expect(
      (await db.collection('pagetagrelations').findOne({}))?.relatedPage,
    ).toEqual(real);
    expect(
      (await db.collection('sharelinks').findOne({}))?.relatedPage,
    ).toEqual(real);
    expect((await db.collection('subscriptions').findOne({}))?.target).toEqual(
      real,
    );
    expect(
      (await db.collection('inappnotifications').findOne({}))?.target,
    ).toEqual(placeholder);
    expect(
      (await db.collection('pageredirects').findOne({ fromPath: '/teams/' }))
        ?.toPath,
    ).toBe('/teams');
    expect(
      (await db.collection('pageredirects').findOne({ fromPath: '/old-teams' }))
        ?.toPath,
    ).toBe('/teams');

    const after = await readSnapshot(db);
    const rerun = buildPlan(after, db.databaseName);
    expect(rerun.merges).toEqual([]);
    await applyPlan(client, db, rerun);
    expect(await readSnapshot(db)).toEqual(after);
  });

  it('rejects a stale reviewed plan before changing anything', async () => {
    const reviewed = buildPlan(await readSnapshot(db), db.databaseName);
    await db
      .collection('pages')
      .updateOne({ _id: child }, { $set: { path: '/teams/renamed' } });
    const before = await readSnapshot(db);

    await expect(applyPlan(client, db, reviewed)).rejects.toThrow(
      'Database changed',
    );
    expect(await readSnapshot(db)).toEqual(before);
  });

  it('rolls back all reference changes when a unique bookmark constraint would be violated', async () => {
    await db
      .collection('bookmarks')
      .createIndex({ page: 1, user: 1 }, { unique: true });
    await db.collection('bookmarks').insertMany([
      { page: real, user },
      { page: placeholder, user },
    ]);
    await db.collection('comments').insertOne({ page: placeholder });
    const before = await readSnapshot(db);
    const reviewed = buildPlan(before, db.databaseName);

    await expect(applyPlan(client, db, reviewed)).rejects.toThrow(
      /duplicate key/i,
    );
    expect(await readSnapshot(db)).toEqual(before);
    expect((await db.collection('comments').findOne({}))?.page).toEqual(
      placeholder,
    );
  });
});
