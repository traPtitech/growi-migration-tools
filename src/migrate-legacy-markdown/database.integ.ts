import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { applyPlan, assertPlan, buildPlan } from './database.ts';

const uri = process.env.TEST_MONGO_URI;
describe.skipIf(!uri)('legacy markdown migration database', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(
    `growi_legacy_markdown_${randomUUID().replaceAll('-', '')}`,
  );
  const page = new ObjectId();
  const revision = new ObjectId();
  const older = new ObjectId();

  beforeAll(async () => client.connect());
  afterAll(async () => {
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
  });
  beforeEach(async () => {
    await db.dropDatabase();
    await db.collection('pages').insertOne({ _id: page, revision });
    await db.collection('revisions').insertMany([
      {
        _id: revision,
        pageId: page,
        body: ':::success\n[/current] <//other>\n:::',
        author: page,
      },
      { _id: older, pageId: page, body: ':::success\n[/history]\n:::' },
    ]);
  });

  it('updates only current revisions and preserves other fields and history', async () => {
    const before = await db.collection('revisions').findOne({ _id: revision });
    const plan = await buildPlan(db);
    expect(plan.revisions).toHaveLength(1);
    expect(await applyPlan(client, db, plan)).toBe(1);
    expect(await db.collection('revisions').findOne({ _id: revision })).toEqual(
      {
        ...before,
        body: ':::tip\n[[/current]] [[/other]]\n:::',
      },
    );
    expect(
      (await db.collection('revisions').findOne({ _id: older }))?.body,
    ).toBe(':::success\n[/history]\n:::');
    expect((await buildPlan(db)).revisions).toHaveLength(0);
  });

  it('rolls back earlier body updates when a later update fails', async () => {
    const secondPage = new ObjectId('eeeeeeeeeeeeeeeeeeeeeeee');
    const secondRevision = new ObjectId('ffffffffffffffffffffffff');
    const blockedBefore = ':::success\n[/blocked]\n:::';
    const blockedAfter = ':::tip\n[[/blocked]]\n:::';
    await db.collection('pages').insertOne({
      _id: secondPage,
      revision: secondRevision,
    });
    await db.collection('revisions').insertOne({
      _id: secondRevision,
      pageId: secondPage,
      body: blockedBefore,
    });
    await db.command({
      collMod: 'revisions',
      validator: { body: { $ne: blockedAfter } },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    try {
      const plan = await buildPlan(db);
      await expect(applyPlan(client, db, plan)).rejects.toThrow();
      expect(
        (await db.collection('revisions').findOne({ _id: revision }))?.body,
      ).toBe(':::success\n[/current] <//other>\n:::');
      expect(
        (await db.collection('revisions').findOne({ _id: secondRevision }))
          ?.body,
      ).toBe(blockedBefore);
    } finally {
      await db.command({ collMod: 'revisions', validator: {} });
    }
  });

  it('rejects altered plans and stale database state', async () => {
    const plan = await buildPlan(db);
    expect(() => assertPlan(plan, { ...plan, revisions: [] })).toThrow(
      'Plan does not match',
    );
    await db
      .collection('revisions')
      .updateOne({ _id: revision }, { $set: { body: 'changed' } });
    await expect(applyPlan(client, db, plan)).rejects.toThrow(
      'Plan does not match',
    );
    expect(
      (await db.collection('revisions').findOne({ _id: revision }))?.body,
    ).toBe('changed');
  });
});
