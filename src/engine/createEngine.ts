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
import { copyGitObjects, ensureOrigin, originExists } from './remote';

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
    originDir: `${deps.dir}-origin`,
    author: { ...PLAYER_AUTHOR },
    now: deps.now ?? (() => Math.floor(Date.now() / 1000)),
  };
  let setupCommits = 0;
  let patchSession: PatchSession | null = null;

  // Phase 9: when the level has an origin, the snapshot carries a normalized
  // view of it (snap.remote). Local remote-tracking refs ride along in
  // snap.remoteBranches via readRawRepo either way.
  const snapshot = async (): Promise<RepoSnapshot> => {
    const local = normalizeRepo(await readRawRepo(ctx));
    if (await originExists(ctx)) {
      local.remote = normalizeRepo(await readRawRepo({ ...ctx, dir: ctx.originDir }));
    }
    return local;
  };

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
      case 'remotePush': {
        // The "you cloned this" state: origin gets the local branch's objects
        // and tip, and the local remote-tracking ref is born synced.
        await ensureOrigin(ctx);
        const sha = await git
          .resolveRef({ fs: gitFs, dir: deps.dir, ref: `refs/heads/${op.branch}`, depth: 10 })
          .catch(() => null);
        if (!sha) throw new Error(`remotePush: local branch '${op.branch}' does not exist`);
        await copyGitObjects(ctx, deps.dir, ctx.originDir);
        await git.writeRef({
          fs: gitFs,
          dir: ctx.originDir,
          ref: `refs/heads/${op.branch}`,
          value: sha,
          force: true,
        });
        await git.writeRef({
          fs: gitFs,
          dir: deps.dir,
          ref: `refs/remotes/origin/${op.branch}`,
          value: sha,
          force: true,
        });
        return;
      }
      case 'remoteCommit': {
        // The teammate: commits onto origin's current branch. Deterministic
        // author/timestamp, same monotonic clock as local setup commits.
        await ensureOrigin(ctx);
        for (const [path, content] of Object.entries(op.files)) {
          await writeTextFile(fs, joinPath(ctx.originDir, path), content);
          await git.add({ fs: gitFs, dir: ctx.originDir, filepath: path });
        }
        const timestamp = T0 + setupCommits * 60;
        const who = { ...LEVEL_AUTHOR, timestamp, timezoneOffset: 0 };
        await git.commit({
          fs: gitFs,
          dir: ctx.originDir,
          message: op.message,
          author: who,
          committer: who,
        });
        setupCommits += 1;
        return;
      }
    }
  };

  return {
    async buildLevel(setup: SetupOp[]): Promise<RepoSnapshot> {
      await rmrf(fs, deps.dir);
      await rmrf(fs, ctx.originDir); // no origin unless this level makes one
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
