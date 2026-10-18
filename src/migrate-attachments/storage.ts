import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { FileRef } from './database.ts';

async function digest(
  path: string,
): Promise<{ sha256: string; size: number } | undefined> {
  const child = spawn('rclone', ['cat', path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hash = createHash('sha256');
  let size = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    hash.update(chunk);
  });
  child.stderr.resume();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code === 3 || code === 4) return;
  if (code !== 0) throw new Error(`rclone cat failed (exit ${code})`);
  return { sha256: hash.digest('hex'), size };
}

export async function transferFile(
  file: FileRef,
  source: string,
  destination: string,
): Promise<'verified' | 'missing' | 'size-mismatch'> {
  const sourcePath = `${source.replace(/\/$/, '')}/${file.filePath}`;
  const destinationPath = `${destination.replace(/\/$/, '')}/${file.filePath}`;
  const original = await digest(sourcePath);
  if (!original) return 'missing';
  if (original.size !== file.fileSize) return 'size-mismatch';
  let copied = await digest(destinationPath);
  if (
    copied &&
    (copied.size !== original.size || copied.sha256 !== original.sha256)
  )
    throw new Error(
      `Destination content differs for attachment ${file.id}; refusing to overwrite`,
    );
  if (!copied) {
    const child = spawn(
      'rclone',
      ['copyto', '--immutable', sourcePath, destinationPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    child.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0)
      throw new Error(
        `rclone copyto failed for attachment ${file.id} (exit ${code})`,
      );
    copied = await digest(destinationPath);
  }
  if (
    !copied ||
    copied.size !== original.size ||
    copied.sha256 !== original.sha256
  )
    throw new Error(
      `Copied content failed SHA-256 verification for attachment ${file.id}`,
    );
  return 'verified';
}
