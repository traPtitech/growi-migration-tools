import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MongoClient } from 'mongodb';
import {
  applyBodies,
  assertPlan,
  buildPlan,
  type Options,
} from './database.ts';
import { transferFile } from './storage.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      database: { type: 'string' },
      report: { type: 'string' },
      plan: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'wiki-origin': { type: 'string' },
      'swift-base': { type: 'string' },
      source: { type: 'string' },
      destination: { type: 'string' },
    },
  });
  const { database, report, source, destination } = values;
  const wikiOrigin = values['wiki-origin'];
  const swiftBase = values['swift-base'];
  if (
    !process.env.MONGO_URI ||
    !database ||
    !report ||
    !wikiOrigin ||
    !swiftBase ||
    !source ||
    !destination ||
    (values.apply && !values.plan)
  )
    throw new Error(
      'Set MONGO_URI and pass --database --report --wiki-origin --swift-base --source --destination; --apply requires --plan',
    );
  if (['admin', 'config', 'local'].includes(database))
    throw new Error('System databases are not supported');
  const wiki = new URL(wikiOrigin);
  const swift = new URL(swiftBase);
  if (
    !['http:', 'https:'].includes(wiki.protocol) ||
    wiki.origin !== wikiOrigin ||
    swift.protocol !== 'https:' ||
    swift.username ||
    swift.password ||
    swift.search ||
    swift.hash ||
    !/^\/v1\/nc_[a-f0-9]+\/crowi\/$/.test(swift.pathname)
  )
    throw new Error(
      'Use a wiki origin and an HTTPS Swift base ending in /v1/nc_<tenant>/crowi/',
    );
  if (
    source.startsWith('-') ||
    destination.startsWith('-') ||
    source.replace(/\/$/, '') === destination.replace(/\/$/, '')
  )
    throw new Error('Use distinct source and destination roots');
  if (values.plan && resolve(values.plan) === resolve(report))
    throw new Error('Use a separate report file');
  const options: Options = { wikiOrigin, swiftBase, source, destination };
  const reviewed: unknown = values.apply
    ? JSON.parse(await readFile(values.plan ?? '', 'utf8'))
    : undefined;
  const output = await open(report, 'wx', 0o600);
  const client = new MongoClient(process.env.MONGO_URI);
  const verifiedIds = new Set<string>();
  const skipped: { id: string; reason: string }[] = [];
  let updated = 0;
  try {
    await client.connect();
    const db = client.db(database);
    const plan = await buildPlan(db, options);
    if (!values.apply) {
      await output.writeFile(`${JSON.stringify(plan)}\n`);
    } else {
      assertPlan(plan, reviewed);
      try {
        for (const file of plan.files) {
          const status = await transferFile(file, source, destination);
          if (status === 'verified') verifiedIds.add(file.id);
          else skipped.push({ id: file.id, reason: status });
          process.stderr.write(
            `Verified ${verifiedIds.size}, skipped ${skipped.length} / ${plan.files.length}\r`,
          );
        }
        updated = await applyBodies(client, db, plan, verifiedIds);
        await output.writeFile(
          `${JSON.stringify({ database, verified: [...verifiedIds], skipped, updated })}\n`,
        );
      } catch (error) {
        await output.writeFile(
          `${JSON.stringify({ database, verified: [...verifiedIds], skipped, status: 'failed', error: error instanceof Error ? error.message : 'Migration failed' })}\n`,
        );
        throw error;
      }
    }
    process.stdout.write(
      `${JSON.stringify({ mode: values.apply ? 'applied' : 'dry-run', files: plan.files.length, revisions: values.apply ? updated : plan.revisions.length, skippedAttachments: plan.skippedAttachments, verified: verifiedIds.size, skippedFiles: skipped.length, report })}\n`,
    );
  } finally {
    await output.close();
    await client.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Migration failed'}\n`,
  );
  process.exitCode = 1;
});
