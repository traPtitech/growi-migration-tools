import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { applyBodies, assertPlan, buildPlan } from './database.ts';

const uri = process.env.TEST_MONGO_URI;
describe.skipIf(!uri)('attachment migration database', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(
    `growi_attachment_test_${randomUUID().replaceAll('-', '')}`,
  );
  const page = new ObjectId();
  const revision = new ObjectId();
  const older = new ObjectId();
  const attachment = new ObjectId();
  const options = {
    wikiOrigin: 'https://wiki.example.test',
    swiftBase: 'https://swift.example.test/v1/nc_abc/crowi/',
    source: 'swift:crowi',
    destination: 's3:bucket',
  };
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
      .collection('pages')
      .insertOne({ _id: page, revision, grant: 4, path: '/private' });
    await db.collection('revisions').insertMany([
      {
        _id: revision,
        pageId: page,
        body: `![](/files/${attachment})`,
        author: page,
        createdAt: new Date('2017-01-01Z'),
      },
      { _id: older, pageId: page, body: `![](/files/${attachment})` },
    ]);
    await db.collection('attachments').insertOne({
      _id: attachment,
      page,
      filePath: `attachment/${page}/33333333333333333333333333333333.png`,
      fileSize: 5,
    });
  });
  it('updates only the current body after verification and preserves metadata and history', async () => {
    const before = await db.collection('revisions').findOne({ _id: revision });
    const originalPage = await db.collection('pages').findOne({ _id: page });
    const originalAttachment = await db
      .collection('attachments')
      .findOne({ _id: attachment });
    const plan = await buildPlan(db, options);
    expect(plan.revisions).toHaveLength(1);
    expect(await applyBodies(client, db, plan, new Set())).toBe(0);
    expect(
      await applyBodies(client, db, plan, new Set([attachment.toHexString()])),
    ).toBe(1);
    expect(await db.collection('revisions').findOne({ _id: revision })).toEqual(
      { ...before, body: `![](/attachment/${attachment})` },
    );
    expect(
      (await db.collection('revisions').findOne({ _id: older }))?.body,
    ).toBe(`![](/files/${attachment})`);
    expect(await db.collection('pages').findOne({ _id: page })).toEqual(
      originalPage,
    );
    expect(
      await db.collection('attachments').findOne({ _id: attachment }),
    ).toEqual(originalAttachment);
    expect((await buildPlan(db, options)).revisions).toHaveLength(0);
  });
  it('ignores orphaned attachments, duplicate keys and inconsistent revision ownership', async () => {
    await db.collection('attachments').insertOne({
      page,
      filePath: `attachment/${page}/33333333333333333333333333333333.png`,
      fileSize: 5,
    });
    expect((await buildPlan(db, options)).files).toHaveLength(0);
    await db.collection('attachments').deleteOne({ _id: attachment });
    await db
      .collection('attachments')
      .updateMany({}, { $set: { page: new ObjectId() } });
    expect((await buildPlan(db, options)).files).toHaveLength(0);
    await db
      .collection('revisions')
      .updateOne({ _id: revision }, { $set: { pageId: new ObjectId() } });
    expect((await buildPlan(db, options)).revisions).toHaveLength(0);
  });
  it('rejects modified plans and stale database state before writes', async () => {
    const plan = await buildPlan(db, options);
    expect(() => assertPlan(plan, { ...plan, files: [] })).toThrow(
      'Plan does not match',
    );
    await db
      .collection('pages')
      .updateOne({ _id: page }, { $set: { grant: 1 } });
    await expect(
      applyBodies(client, db, plan, new Set([attachment.toHexString()])),
    ).rejects.toThrow('Plan does not match');
    expect(
      (await db.collection('revisions').findOne({ _id: revision }))?.body,
    ).toBe(`![](/files/${attachment})`);
  });
});
