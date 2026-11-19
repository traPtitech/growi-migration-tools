import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MongoClient } from 'mongodb';
import { applyPlan, assertPlan, buildPlan, type Plan } from './database.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      database: { type: 'string' },
      report: { type: 'string' },
      plan: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (
    !process.env.MONGO_URI ||
    !values.database ||
    !values.report ||
    (values.apply && !values.plan)
  )
    throw new Error(
      'Set MONGO_URI and pass --database NAME --report FILE; --apply also requires --plan FILE',
    );
  if (['admin', 'config', 'local'].includes(values.database))
    throw new Error('System databases are not supported');
  if (values.plan && resolve(values.plan) === resolve(values.report))
    throw new Error('Use separate files for the reviewed plan and report');

  const reviewed: unknown = values.apply
    ? JSON.parse(await readFile(values.plan ?? '', 'utf8'))
    : undefined;
  const report = await open(values.report, 'wx', 0o600);
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const database = values.database;
    const db = client.db(database);
    const plan = await buildPlan(db);
    let updated: number | undefined;
    if (!values.apply) {
      await report.writeFile(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      assertPlan(plan, reviewed);
      updated = await applyPlan(client, db, reviewed as Plan);
      await report.writeFile(
        `${JSON.stringify({ database, updated, fingerprint: plan.fingerprint }, null, 2)}\n`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({ mode: values.apply ? 'applied' : 'dry-run', database, changes: plan.revisions.length, updated, report: values.report })}\n`,
    );
  } finally {
    await report.close();
    await client.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Migration failed'}\n`,
  );
  process.exitCode = 1;
});
