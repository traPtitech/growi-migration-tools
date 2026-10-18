import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transferFile } from './storage.ts';

const available = spawnSync('rclone', ['version']).status === 0;
it.skipIf(!available)(
  'copies bytes, resumes safely and refuses conflicting destination content',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'growi-storage-test-'));
    const source = join(dir, 'source');
    const destination = join(dir, 'destination');
    const file = {
      id: '111111111111111111111111',
      filePath: 'attachment/key.png',
      fileSize: 5,
    };
    try {
      await mkdir(join(source, 'attachment'), { recursive: true });
      await mkdir(destination);
      await writeFile(join(source, file.filePath), 'hello');
      expect(await transferFile(file, source, destination)).toBe('verified');
      expect(await readFile(join(destination, file.filePath), 'utf8')).toBe(
        'hello',
      );
      expect(await transferFile(file, source, destination)).toBe('verified');
      await writeFile(join(destination, file.filePath), 'other');
      await expect(transferFile(file, source, destination)).rejects.toThrow(
        'refusing to overwrite',
      );
      expect(await readFile(join(destination, file.filePath), 'utf8')).toBe(
        'other',
      );
      expect(
        await transferFile(
          { ...file, filePath: 'absent' },
          source,
          destination,
        ),
      ).toBe('missing');
      expect(
        await transferFile({ ...file, fileSize: 6 }, source, destination),
      ).toBe('size-mismatch');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
