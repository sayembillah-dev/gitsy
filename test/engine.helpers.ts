import * as nodeFs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SetupOp } from '@/core/types';
import { createEngine } from '@/engine/createEngine';

export async function makeEngine() {
  const dir = await mkdtemp(join(tmpdir(), 'gitsy-'));
  const engine = createEngine({ fs: nodeFs, dir });
  const writeWorkdirFile = (path: string, content: string) =>
    writeFile(join(dir, path), content, 'utf8');
  return { engine, dir, writeWorkdirFile };
}

export const INITIAL_SETUP: SetupOp[] = [
  { op: 'commit', message: 'initial commit', files: { 'a.txt': 'alpha\n', 'b.txt': 'bravo\n' } },
];
