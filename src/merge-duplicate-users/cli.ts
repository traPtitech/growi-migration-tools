import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MongoClient } from 'mongodb';
import { applyPlan, buildPlan, parseAliases } from './index.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      database: { type: 'string' },
      report: { type: 'string' },
      aliases: { type: 'string' },
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
  for (const input of [values.plan, values.aliases].filter((v): v is string =>
    Boolean(v),
  ))
    if (resolve(input) === resolve(values.report))
      throw new Error('Use a separate report file');
  const aliases = values.aliases
    ? parseAliases(JSON.parse(await readFile(values.aliases, 'utf8')))
    : [];
  const reviewed = values.apply
    ? JSON.parse(await readFile(values.plan ?? '', 'utf8'))
    : undefined;
  const report = await open(values.report, 'wx', 0o600);
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db(values.database);
    const plan = values.apply
      ? await applyPlan(client, db, reviewed, aliases)
      : await buildPlan(db, aliases);
    await report.writeFile(`${JSON.stringify(plan)}\n`);
    process.stdout.write(
      `${JSON.stringify({ mode: values.apply ? 'applied' : 'dry-run', database: db.databaseName, groups: plan.groups.length, removedUsers: plan.groups.reduce((n, g) => n + g.removeIds.length, 0), changes: plan.changes.length, referenceUpdates: plan.referenceUpdates, report: values.report }, null, 2)}\n`,
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
