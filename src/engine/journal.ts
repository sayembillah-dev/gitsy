// Engine-side journals (Phase 10): the small state files that make Act 4/5
// machinery work. All live under .git/ as plain JSON so they ride along with
// the repo directory and vanish on buildLevel's rmrf. None of this crosses
// the worker boundary; readState folds it into RawRepo for normalize.
//
//   .git/gitsy-reflog.json     append-only ref movements (Act 5 reflog)
//   .git/gitsy-stash.json      the stash stack (stash push/pop)
//   .git/gitsy-worktrees.json  linked worktrees (git worktree add)
//   .git/gitsy-bisect.json     an in-flight bisect session
//   .git/gitsy-rebase.json     an in-flight rebase (todo pending or conflict)

import { joinPath, pathExists, readTextFile, writeTextFile, type EngineContext } from './fsx';

async function readJson<T>(ctx: EngineContext, name: string, fallback: T): Promise<T> {
  const path = joinPath(ctx.dir, '.git', name);
  if (!(await pathExists(ctx.fs, path))) return fallback;
  try {
    return JSON.parse(await readTextFile(ctx.fs, path)) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(ctx: EngineContext, name: string, value: unknown): Promise<void> {
  await writeTextFile(ctx.fs, joinPath(ctx.dir, '.git', name), JSON.stringify(value));
}

async function removeFile(ctx: EngineContext, name: string): Promise<void> {
  await ctx.fs.unlink(joinPath(ctx.dir, '.git', name)).catch(() => undefined);
}

// ---- reflog ---------------------------------------------------------------

export interface ReflogEntry {
  /** e.g. "HEAD" or "refs/heads/main" or "refs/stash". */
  ref: string;
  /** git SHA before the move; null at creation. */
  from: string | null;
  /** git SHA after the move. */
  to: string;
  /** e.g. "commit: add app", "reset: moving to HEAD~1". */
  label: string;
}

const REFLOG = 'gitsy-reflog.json';

export async function readReflog(ctx: EngineContext): Promise<ReflogEntry[]> {
  return readJson<ReflogEntry[]>(ctx, REFLOG, []);
}

/** Records a ref movement. Every user-visible movement (commit, amend,
 *  reset, checkout, rebase, stash push, fetch...) calls this; it is what
 *  makes `git reflog` real and feeds snapshot.reflog for stillReachable. */
export async function logRef(
  ctx: EngineContext,
  ref: string,
  from: string | null,
  to: string,
  label: string,
): Promise<void> {
  const entries = await readReflog(ctx);
  entries.push({ ref, from, to, label });
  await writeJson(ctx, REFLOG, entries);
}

// ---- stash stack ------------------------------------------------------------

export interface StashEntry {
  sha: string;
  message: string;
}

const STASH = 'gitsy-stash.json';

/** The stash stack, oldest entry first (index 0 is the bottom). */
export async function readStashStack(ctx: EngineContext): Promise<StashEntry[]> {
  return readJson<StashEntry[]>(ctx, STASH, []);
}

export async function pushStash(ctx: EngineContext, entry: StashEntry): Promise<void> {
  const stack = await readStashStack(ctx);
  stack.push(entry);
  await writeJson(ctx, STASH, stack);
}

/** Removes and returns the newest stash entry (the top of the stack). */
export async function popStash(ctx: EngineContext): Promise<StashEntry | null> {
  const stack = await readStashStack(ctx);
  const entry = stack.pop() ?? null;
  await writeJson(ctx, STASH, stack);
  return entry;
}

// ---- worktrees --------------------------------------------------------------

export interface WorktreeEntry {
  /** The path exactly as the player typed it (display). */
  path: string;
  /** The real directory on the engine fs. */
  dir: string;
  branch: string;
}

const WORKTREES = 'gitsy-worktrees.json';

export async function readWorktrees(ctx: EngineContext): Promise<WorktreeEntry[]> {
  return readJson<WorktreeEntry[]>(ctx, WORKTREES, []);
}

export async function addWorktree(ctx: EngineContext, entry: WorktreeEntry): Promise<void> {
  const list = await readWorktrees(ctx);
  list.push(entry);
  await writeJson(ctx, WORKTREES, list);
}

export async function removeWorktree(ctx: EngineContext, path: string): Promise<boolean> {
  const list = await readWorktrees(ctx);
  const kept = list.filter((w) => w.path !== path);
  if (kept.length === list.length) return false;
  await writeJson(ctx, WORKTREES, kept);
  return true;
}

// ---- bisect state -------------------------------------------------------------

export interface BisectState {
  bad: string | null;
  good: string[];
  /** Candidate chain under test, newest first. */
  chain: string[];
  /** Where the player was when the bisect started (reset returns there). */
  startRef: { type: 'branch'; name: string } | { type: 'detached'; sha: string };
}

const BISECT = 'gitsy-bisect.json';

export async function readBisect(ctx: EngineContext): Promise<BisectState | null> {
  return readJson<BisectState | null>(ctx, BISECT, null);
}

export async function writeBisect(ctx: EngineContext, state: BisectState): Promise<void> {
  await writeJson(ctx, BISECT, state);
}

export async function clearBisect(ctx: EngineContext): Promise<void> {
  await removeFile(ctx, BISECT);
}

// ---- rebase state -------------------------------------------------------------

export interface RebaseStep {
  sha: string;
  message: string;
  /** pick | squash | drop | reword; reword carries the inline replacement. */
  verb: 'pick' | 'squash' | 'drop' | 'reword';
  rewordMessage?: string;
}

export interface RebaseState {
  onto: string;
  /** Branch being rebased; null when HEAD was detached. */
  branch: string | null;
  originalTip: string;
  /** Steps still to apply, in order. */
  remaining: RebaseStep[];
  /** The step that hit a conflict and waits for --continue. */
  pending: RebaseStep | null;
  /** Original SHA whose replayed commit is currently the tip (squash folds
   *  into it, so its rewrite entry must track the fold). */
  lastPick: string | null;
  /** For squash: message accumulated so far replaces the tip on amend. */
  squashMessage: string | null;
  /** Old SHA to new SHA as commits are replayed. */
  rewrites: Record<string, string>;
  /** True while the REBASE_TODO worksheet waits in the workdir (-i flow). */
  todoPending: boolean;
  /** Full candidate list captured at start (for todo validation). */
  candidates: RebaseStep[];
}

const REBASE = 'gitsy-rebase.json';

export async function readRebase(ctx: EngineContext): Promise<RebaseState | null> {
  return readJson<RebaseState | null>(ctx, REBASE, null);
}

export async function writeRebase(ctx: EngineContext, state: RebaseState): Promise<void> {
  await writeJson(ctx, REBASE, state);
}

export async function clearRebase(ctx: EngineContext): Promise<void> {
  await removeFile(ctx, REBASE);
}

/** The interactive-rebase worksheet lives in the WORKDIR (not .git) so the
 *  file-editor surface can open it like any other file. It is deleted the
 *  moment the rebase finishes or aborts, and `git add` refuses to stage it. */
export const REBASE_TODO_PATH = 'REBASE_TODO';
