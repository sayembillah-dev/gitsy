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
import { answerPatch, startPatch, type PatchSession } from './patch';
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

/**
 * The engine as the terminal sees it: the frozen GitEngine contract plus the
 * interactive patch channel. types.ts stays untouched; `answer` only matters
 * while a `git add -p` session is open (Phase 3).
 */
export interface PatchEngine extends GitEngine {
  answer(input: string): Promise<CommandResult>;
}

/**
 * Phase 5 extension: the file-editor surface. `editFile` is how the UI's
 * editor panel saves bytes to the workdir. It is deliberately NOT a terminal
 * command (no parser grammar, no commandCount): editing a file is something
 * you do in your editor, not something git sees.
 */
export interface EditorEngine extends PatchEngine {
  editFile(path: string, content: string): Promise<CommandResult>;
}

export function createEngine(deps: EngineDeps): EditorEngine {
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
  let patchSession: PatchSession | null = null;

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
      patchSession = null;
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
        if (parsed.command.cmd === 'add' && parsed.command.patch) {
          if (patchSession) {
            out = { ok: false, stdout: '', stderr: 'fatal: a patch session is already open\n' };
          } else {
            const started = await startPatch(ctx, parsed.command.paths);
            patchSession = started.session;
            out = { ok: true, stdout: started.out, stderr: '' };
          }
        } else {
          out = await execute(ctx, parsed.command);
        }
      } catch (err) {
        out = {
          ok: false,
          stdout: '',
          stderr: `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
        };
      }
      return { ok: out.ok, stdout: out.stdout, stderr: out.stderr, snapshot: await snapshot() };
    },

    async answer(input: string): Promise<CommandResult> {
      if (!patchSession) {
        return {
          ok: false,
          stdout: '',
          stderr: 'fatal: no patch session in progress\n',
          snapshot: await snapshot(),
        };
      }
      try {
        const step = await answerPatch(ctx, patchSession, input);
        if (step.done) patchSession = null;
        return { ok: true, stdout: step.text, stderr: '', snapshot: await snapshot() };
      } catch (err) {
        patchSession = null;
        return {
          ok: false,
          stdout: '',
          stderr: `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
          snapshot: await snapshot(),
        };
      }
    },

    async editFile(path: string, content: string): Promise<CommandResult> {
      const raw = path.trim().replace(/\\/g, '/');
      const clean = raw.replace(/^\/+/, '').replace(/\/+$/, '');
      const segments = clean.split('/');
      const invalid =
        raw.length === 0 ||
        raw.startsWith('/') || // absolute (or UNC after the backslash fold)
        /^[A-Za-z]:/.test(raw) ||
        segments.some((s) => s === '' || s === '..') ||
        segments[0] === '.git';
      if (invalid) {
        return {
          ok: false,
          stdout: '',
          stderr: `fatal: invalid path '${path}'\n`,
          snapshot: await snapshot(),
        };
      }
      await writeTextFile(fs, joinPath(deps.dir, clean), content);
      return { ok: true, stdout: '', stderr: '', snapshot: await snapshot() };
    },

    snapshot,
  };
}
