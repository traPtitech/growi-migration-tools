import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MongoClient } from 'mongodb';
import { applyPlan, buildPlan } from './database.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      database: { type: 'string' },
      report: { type: 'string' },
      apply: { type: 'boolean', default: false },
      plan: { type: 'string' },
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
  for (const input of [values.plan].filter((v): v is string => Boolean(v)))
    if (resolve(input) === resolve(values.report))
      throw new Error('Use a separate report file');
  const reviewed = values.apply
    ? JSON.parse(await readFile(values.plan ?? '', 'utf8'))
    : undefined;
  const report = await open(values.report, 'wx', 0o600);
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db(values.database);
    const plan = values.apply
      ? await applyPlan(client, db, reviewed)
      : await buildPlan(db);
    await report.writeFile(`${JSON.stringify(plan)}\n`);
    process.stdout.write(
      `${JSON.stringify({ mode: values.apply ? 'applied' : 'dry-run', database: db.databaseName, dropConfigIndex: plan.dropConfigIndex, pages: plan.pathUpdates.length, revisions: plan.pathUpdates.reduce((n, p) => n + p.revisionIds.length, 0), report: values.report }, null, 2)}\n`,
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
