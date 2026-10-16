import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MongoClient } from 'mongodb';

import { applyPlan, buildPlan, readSnapshot } from './index.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      database: { type: 'string' },
      report: { type: 'string' },
      apply: { type: 'boolean', default: false },
      plan: { type: 'string' },
    },
  });
  const uri = process.env.MONGO_URI;
  if (
    !uri ||
    !values.database ||
    !values.report ||
    (values.apply && !values.plan)
  ) {
    throw new Error(
      'Set MONGO_URI and pass --database NAME --report FILE; --apply also requires --plan FILE',
    );
  }
  if (['admin', 'config', 'local'].includes(values.database))
    throw new Error('System databases are not supported');
  if (values.apply && resolve(values.plan ?? '') === resolve(values.report)) {
    throw new Error(
      'Use separate files for the reviewed plan and execution report',
    );
  }
  const reviewed = values.apply
    ? JSON.parse(await readFile(values.plan ?? '', 'utf8'))
    : undefined;
  const report = await open(values.report, 'w', 0o600);
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(values.database);
    const result = values.apply
      ? await applyPlan(client, db, reviewed)
      : { plan: buildPlan(await readSnapshot(db), db.databaseName) };
    await report.writeFile(
      `${JSON.stringify(
        {
          ...result.plan,
          ...('referenceUpdates' in result
            ? { referenceUpdates: result.referenceUpdates }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: values.apply ? 'applied' : 'dry-run',
          database: db.databaseName,
          normalizedGroups: result.plan.merges.length,
          removedEmptyPages: result.plan.merges.reduce(
            (n, m) => n + m.removeIds.length,
            0,
          ),
          updatedPages: result.plan.pageUpdates.length,
          skippedGroups: result.plan.skipped.length,
          referenceUpdates:
            'referenceUpdates' in result ? result.referenceUpdates : undefined,
          report: values.report,
        },
        null,
        2,
      )}\n`,
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
