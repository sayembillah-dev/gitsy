// The remote simulation (Phase 9, BUILD-PLAN "Remote simulation -> Act 3").
//
// `origin` is a second repository directory on the SAME fs (a second
// lightning-fs dir in the worker, a sibling dir in tests). fetch and push
// run directly between the two directories: no HTTP transport, ever
// (section 6 trap table). Object transfer is a plain recursive copy of
// .git/objects: loose objects are content-addressed and immutable, so
// copying is both correct and cheap.
//
// Teaching shape: remoteCommit/remotePush setup ops script the remote's
// side deterministically ("a teammate pushed while you worked"); the player
// only ever runs fetch / push / pull / remote against it.

import git from 'isomorphic-git';
import {
  joinPath,
  mkdirp,
  pathExists,
  type EngineContext,
  type FsLike,
} from './fsx';

export interface RemoteOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const ok = (stdout = ''): RemoteOutput => ({ ok: true, stdout, stderr: '' });
const fail = (stderr: string): RemoteOutput => ({ ok: false, stdout: '', stderr });
const short = (sha: string) => sha.slice(0, 7);

export const NO_ORIGIN =
  `fatal: 'origin' does not appear to be a git repository\n` +
  'fatal: Could not read from remote repository.\n';

export async function originExists(ctx: EngineContext): Promise<boolean> {
  return pathExists(ctx.fs, joinPath(ctx.originDir, '.git'));
}

export async function ensureOrigin(ctx: EngineContext): Promise<void> {
  if (await originExists(ctx)) return;
  await mkdirp(ctx.fs, ctx.originDir);
  await git.init({ fs: ctx.gitFs, dir: ctx.originDir, defaultBranch: 'main' });
}

/** Recursively copies .git/objects from one repo dir to another. */
export async function copyGitObjects(
  ctx: EngineContext,
  fromDir: string,
  toDir: string,
): Promise<void> {
  const copyTree = async (fs: FsLike, src: string, dst: string): Promise<void> => {
    if (!(await pathExists(fs, src))) return;
    await mkdirp(fs, dst);
    for (const name of await fs.readdir(src)) {
      const s = joinPath(src, name);
      const d = joinPath(dst, name);
      const stat = await fs.stat(s);
      if (stat.isDirectory()) {
        await copyTree(fs, s, d);
      } else if (!(await pathExists(fs, d))) {
        // Loose objects are immutable: an existing copy is by definition right.
        const data = await fs.readFile(s);
        await fs.writeFile(d, data);
      }
    }
  };
  await copyTree(ctx.fs, joinPath(fromDir, '.git', 'objects'), joinPath(toDir, '.git', 'objects'));
}

/** Resolves a ref in the given repo dir, or null when it does not exist. */
async function resolveIn(
  ctx: EngineContext,
  dir: string,
  ref: string,
): Promise<string | null> {
  try {
    return await git.resolveRef({ fs: ctx.gitFs, dir, ref, depth: 10 });
  } catch {
    return null;
  }
}

/** True when `target` is reachable from `from` (or equal to it). */
async function shaReachable(
  ctx: EngineContext,
  from: string,
  target: string,
): Promise<boolean> {
  if (from === target) return true;
  try {
    const log = await git.log({ fs: ctx.gitFs, dir: ctx.dir, ref: from });
    return log.some((e) => e.oid === target);
  } catch {
    return false;
  }
}

export interface FetchResult extends RemoteOutput {
  /** [branch, newSha] pairs whose remote-tracking refs moved. */
  moved: { branch: string; sha: string }[];
}

/**
 * git fetch: copy origin's objects down, then update refs/remotes/origin/*
 * to match origin's refs/heads/*. Local branches never move. THAT is the
 * Act 3 cliff: origin/main is a local cache.
 */
export async function fetchFromOrigin(ctx: EngineContext): Promise<FetchResult> {
  if (!(await originExists(ctx))) return { ...fail(NO_ORIGIN), moved: [] };

  await copyGitObjects(ctx, ctx.originDir, ctx.dir);

  const lines: string[] = [];
  const moved: FetchResult['moved'] = [];
  const names = await git.listBranches({ fs: ctx.gitFs, dir: ctx.originDir });
  for (const name of names.sort()) {
    const sha = await resolveIn(ctx, ctx.originDir, `refs/heads/${name}`);
    if (!sha) continue;
    const tracking = `refs/remotes/origin/${name}`;
    const old = await resolveIn(ctx, ctx.dir, tracking);
    if (old === sha) continue;
    await git.writeRef({ fs: ctx.gitFs, dir: ctx.dir, ref: tracking, value: sha, force: true });
    moved.push({ branch: name, sha });
    lines.push(
      old === null
        ? ` * [new branch]      ${name}     -> origin/${name}`
        : `   ${short(old)}..${short(sha)}  ${name}     -> origin/${name}`,
    );
  }
  if (lines.length === 0) return { ...ok(), moved };
  return { ...ok(`From ${ctx.originDir}\n${lines.join('\n')}\n`), moved };
}

export interface PushOptions {
  branch: string;
  force: boolean;
  forceWithLease: boolean;
  setUpstream: boolean;
}

/**
 * git push: fast-forward checks, then copy objects UP and move origin's
 * refs/heads/<branch>. The local remote-tracking ref moves too (real git
 * updates it for pushed refs). --force-with-lease refuses when origin moved
 * since our last fetch: the taught-safe way to rewrite a remote.
 */
export async function pushToOrigin(
  ctx: EngineContext,
  opts: PushOptions,
): Promise<RemoteOutput> {
  if (!(await originExists(ctx))) {
    return fail(
      'fatal: No configured push destination.\n' +
        'hint: this repository has no origin; remotes arrive with Act 3\n',
    );
  }
  const { branch } = opts;
  const localTip = await resolveIn(ctx, ctx.dir, `refs/heads/${branch}`);
  if (!localTip) {
    return fail(
      `error: src refspec ${branch} does not match any\n` +
        `error: failed to push some refs to '${ctx.originDir}'\n`,
    );
  }

  const remoteTip = await resolveIn(ctx, ctx.originDir, `refs/heads/${branch}`);
  if (remoteTip === localTip) return ok('Everything up-to-date\n');

  let forced = false;
  if (remoteTip !== null) {
    const ff = await shaReachable(ctx, localTip, remoteTip);
    if (!ff) {
      if (opts.forceWithLease) {
        const trackingTip = await resolveIn(ctx, ctx.dir, `refs/remotes/origin/${branch}`);
        if (trackingTip !== remoteTip) {
          return fail(
            `! [rejected]        ${branch} -> ${branch} (stale info)\n` +
              `error: failed to push some refs to '${ctx.originDir}'\n` +
              'hint: the remote moved since your last fetch. Run git fetch, look\n' +
              'hint: at what changed, then decide whether to force.\n',
          );
        }
        forced = true;
      } else if (!opts.force) {
        return fail(
          `! [rejected]        ${branch} -> ${branch} (non-fast-forward)\n` +
            `error: failed to push some refs to '${ctx.originDir}'\n` +
            'hint: Updates were rejected because the tip of your current branch is behind\n' +
            'hint: its remote counterpart. If you want to integrate the remote changes,\n' +
            "hint: use 'git pull' before pushing again.\n",
        );
      } else {
        forced = true;
      }
    }
  }

  await copyGitObjects(ctx, ctx.dir, ctx.originDir);
  await git.writeRef({
    fs: ctx.gitFs,
    dir: ctx.originDir,
    ref: `refs/heads/${branch}`,
    value: localTip,
    force: true,
  });
  await git.writeRef({
    fs: ctx.gitFs,
    dir: ctx.dir,
    ref: `refs/remotes/origin/${branch}`,
    value: localTip,
    force: true,
  });

  const line =
    remoteTip === null
      ? ` * [new branch]      ${branch} -> ${branch}`
      : forced
        ? ` + ${short(remoteTip)}...${short(localTip)}  ${branch} -> ${branch} (forced update)`
        : `   ${short(remoteTip)}..${short(localTip)}  ${branch} -> ${branch}`;
  const upstream =
    opts.setUpstream || remoteTip === null
      ? `branch '${branch}' set up to track 'origin/${branch}'.\n`
      : '';
  return ok(`To ${ctx.originDir}\n${line}\n${upstream}`);
}

/**
 * Ahead/behind of the local branch vs its remote-tracking ref, for
 * git status. null when there is no tracking ref.
 */
export async function aheadBehind(
  ctx: EngineContext,
  branch: string,
): Promise<{ ahead: number; behind: number } | null> {
  const localTip = await resolveIn(ctx, ctx.dir, `refs/heads/${branch}`);
  const trackingTip = await resolveIn(ctx, ctx.dir, `refs/remotes/origin/${branch}`);
  if (!localTip || !trackingTip) return null;
  if (localTip === trackingTip) return { ahead: 0, behind: 0 };
  const [localLog, trackingLog] = await Promise.all([
    git.log({ fs: ctx.gitFs, dir: ctx.dir, ref: localTip }).catch(() => []),
    git.log({ fs: ctx.gitFs, dir: ctx.dir, ref: trackingTip }).catch(() => []),
  ]);
  const localSet = new Set(localLog.map((e) => e.oid));
  const trackingSet = new Set(trackingLog.map((e) => e.oid));
  return {
    ahead: localLog.filter((e) => !trackingSet.has(e.oid)).length,
    behind: trackingLog.filter((e) => !localSet.has(e.oid)).length,
  };
}
