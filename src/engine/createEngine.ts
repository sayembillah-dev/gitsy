// The GitEngine implementation (BUILD-PLAN section 3 boundary). Wires parser,
// executor, and readState+normalize together. Runs anywhere the fs deps are
// provided: Node in tests, LightningFS in the worker.

import git from 'isomorphic-git';
import { normalizeRepo } from '@/core/normalize';
import type {
  CommandResult,
  GitEngine,
  RepoSnapshot,
  SetupOp,
} from '@/core/types';
import { execute } from './executor';
import {
  joinPath,
  mkdirp,
  rmrf,
  writeTextFile,
  type EngineContext,
  type FsLike,
} from './fsx';
import { parseCommand } from './parser';
import { readRawRepo } from './readState';

// Section 3 determinism rule: fixed author, monotonically incrementing
// timestamps for setup commits. Without this, level SHAs differ per run and
// shareable URLs, snapshot tests, and OG images all break.
export const LEVEL_AUTHOR = { name: 'Level Builder', email: 'level@game.local' } as const;
export const PLAYER_AUTHOR = { name: 'You', email: 'you@gitsy.local' } as const;
export const T0 = 1_700_000_000; // seconds; nth setup commit uses T0 + n * 60

export interface EngineDeps {
  /** node fs module (tests) or LightningFS instance (worker). */
  fs: unknown;
  dir: string;
  /** Injectable clock for tests. Defaults to wall time. */
  now?: () => number;
}

export function createEngine(deps: EngineDeps): GitEngine {
  const gitFs = deps.fs as any;
  const fs = ((gitFs.promises ?? gitFs) as FsLike);
  const ctx: EngineContext = {
    gitFs,
    fs,
    dir: deps.dir,
    author: { ...PLAYER_AUTHOR },
    now: deps.now ?? (() => Math.floor(Date.now() / 1000)),
  };
  let setupCommits = 0;

  const snapshot = async (): Promise<RepoSnapshot> => normalizeRepo(await readRawRepo(ctx));

  const applySetupOp = async (op: SetupOp): Promise<void> => {
    switch (op.op) {
      case 'commit': {
        for (const [path, content] of Object.entries(op.files)) {
          await writeTextFile(fs, joinPath(deps.dir, path), content);
          await git.add({ fs: gitFs, dir: deps.dir, filepath: path });
        }
        const timestamp = T0 + setupCommits * 60;
        const who = { ...LEVEL_AUTHOR, timestamp, timezoneOffset: 0 };
        await git.commit({
          fs: gitFs,
          dir: deps.dir,
          message: op.message,
          author: who,
          committer: who,
        });
        setupCommits += 1;
        return;
      }
      case 'branch':
        return git.branch({ fs: gitFs, dir: deps.dir, ref: op.name });
      case 'checkout':
        return git.checkout({ fs: gitFs, dir: deps.dir, ref: op.ref });
      case 'write':
        return writeTextFile(fs, joinPath(deps.dir, op.path), op.content);
      case 'stage':
        return git.add({ fs: gitFs, dir: deps.dir, filepath: op.path });
      case 'tag':
        return git.tag({ fs: gitFs, dir: deps.dir, ref: op.name });
      case 'remotePush':
      case 'remoteCommit':
        throw new Error(`setup op '${op.op}' arrives with the remote simulation (Phase 9)`);
    }
  };

  return {
    async buildLevel(setup: SetupOp[]): Promise<RepoSnapshot> {
      await rmrf(fs, deps.dir);
      await mkdirp(fs, deps.dir);
      await git.init({ fs: gitFs, dir: deps.dir, defaultBranch: 'main' });
      setupCommits = 0;
      for (const op of setup) await applySetupOp(op);
      return snapshot();
    },

    async run(command: string): Promise<CommandResult> {
      const parsed = parseCommand(command);
      if (!parsed.ok) {
        return { ok: false, stdout: '', stderr: parsed.stderr + '\n', snapshot: await snapshot() };
      }
      let out;
      try {
        out = await execute(ctx, parsed.command);
      } catch (err) {
        out = {
          ok: false,
          stdout: '',
          stderr: `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
        };
      }
      return { ok: out.ok, stdout: out.stdout, stderr: out.stderr, snapshot: await snapshot() };
    },

    snapshot,
  };
}
