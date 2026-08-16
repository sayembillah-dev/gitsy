// Shared ref resolution and small engine utilities (Phase 10 extraction).
// executor.ts, history.ts, stash.ts, and inspect.ts all need the same
// "what SHA does this rev mean" machinery; it lives here so the modules
// never import each other. Owns no user-facing text beyond UNKNOWN_REV.

import git from 'isomorphic-git';
import { flattenTree, headTreeOids, statusRows } from './readState';
import { readReflog, readStashStack } from './journal';
import { joinPath, readTextFile, type EngineContext } from './fsx';

/** What every executor piece returns. rewrites maps OLD git SHA to NEW git
 *  SHA for history-rewriting commands; createEngine converts it to the
 *  StructHash map the frozen CommandResult contract carries. */
export interface ExecOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
  rewrites?: Record<string, string>;
}

export const ok = (stdout = ''): ExecOutput => ({ ok: true, stdout, stderr: '' });
export const fail = (stderr: string): ExecOutput => ({ ok: false, stdout: '', stderr });

export const short = (sha: string): string => sha.slice(0, 7);

export const UNKNOWN_REV = (rev: string): string =>
  `fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.\n` +
  `Use '--' to separate paths from revisions, like this:\n` +
  `'git <command> [<revision>...] -- [<file>...]'\n`;

export type HeadInfo =
  | { type: 'branch'; name: string }
  | { type: 'unborn'; name: string }
  | { type: 'detached'; sha: string };

export async function headInfo(ctx: EngineContext): Promise<HeadInfo> {
  const raw = (await readTextFile(ctx.fs, joinPath(ctx.dir, '.git', 'HEAD'))).trim();
  if (!raw.startsWith('ref: ')) return { type: 'detached', sha: raw };
  const name = raw.slice(5).replace(/^refs\/heads\//, '');
  try {
    await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 5 });
    return { type: 'branch', name };
  } catch {
    return { type: 'unborn', name };
  }
}

export async function branchSha(ctx: EngineContext, name: string): Promise<string | null> {
  try {
    return await git.resolveRef({
      fs: ctx.gitFs,
      dir: ctx.dir,
      ref: `refs/heads/${name}`,
      depth: 10,
    });
  } catch {
    return null;
  }
}

/** Resolves a remote-tracking ref name like "origin/main" to a SHA. */
export async function remoteSha(ctx: EngineContext, name: string): Promise<string | null> {
  if (!name.includes('/')) return null;
  try {
    return await git.resolveRef({
      fs: ctx.gitFs,
      dir: ctx.dir,
      ref: `refs/remotes/${name}`,
      depth: 10,
    });
  } catch {
    return null;
  }
}

/** The flattened path-to-content tree of any commit SHA. */
export async function treeOfRef(ctx: EngineContext, sha: string): Promise<Record<string, string>> {
  const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: sha });
  return flattenTree(ctx, commit.tree);
}

/** path to blob oid for the tree of any ref/SHA (headTreeOids generalized). */
export async function treeOids(ctx: EngineContext, ref: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref, depth: 10 });
    const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: sha });
    const collect = async (oid: string, prefix: string): Promise<void> => {
      const { tree } = await git.readTree({ fs: ctx.gitFs, dir: ctx.dir, oid });
      for (const entry of tree) {
        const path = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === 'tree') await collect(entry.oid, path);
        else map.set(path, entry.oid);
      }
    };
    await collect(commit.tree, '');
  } catch {
    // unborn or unknown ref: empty tree
  }
  return map;
}

/** SHA-prefix scan across every ref's history PLUS the reflog and stash.
 *  The reflog part is what makes Act 5 recovery playable: a commit orphaned
 *  by reset --hard is gone from every branch but still named by the reflog. */
async function shaPrefixScan(ctx: EngineContext, prefix: string): Promise<string | null> {
  const seen = new Set<string>();
  const consider = (sha: string | null): string | null => {
    if (!sha || seen.has(sha)) return null;
    seen.add(sha);
    return sha.startsWith(prefix) ? sha : null;
  };
  const refs = [
    ...(await git.listBranches({ fs: ctx.gitFs, dir: ctx.dir })).map((b) => `refs/heads/${b}`),
    ...(await git.listTags({ fs: ctx.gitFs, dir: ctx.dir })).map((t) => `refs/tags/${t}`),
  ];
  for (const ref of refs) {
    let log;
    try {
      log = await git.log({ fs: ctx.gitFs, dir: ctx.dir, ref });
    } catch {
      continue;
    }
    for (const entry of log) {
      const hit = consider(entry.oid);
      if (hit) return hit;
    }
  }
  for (const entry of await readReflog(ctx)) {
    const hit = consider(entry.to) ?? consider(entry.from);
    if (hit) return hit;
  }
  for (const entry of await readStashStack(ctx)) {
    const hit = consider(entry.sha);
    if (hit) return hit;
  }
  return null;
}

async function resolveBase(ctx: EngineContext, base: string): Promise<string | null> {
  if (base === 'HEAD') {
    try {
      return await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });
    } catch {
      return null;
    }
  }
  const branch = await branchSha(ctx, base);
  if (branch) return branch;
  const tracking = await remoteSha(ctx, base);
  if (tracking) return tracking;
  try {
    return await git.resolveRef({
      fs: ctx.gitFs,
      dir: ctx.dir,
      ref: `refs/tags/${base}`,
      depth: 10,
    });
  } catch {
    // not a tag either: fall through to the SHA-prefix scan
  }
  if (/^[0-9a-f]{4,40}$/.test(base)) return shaPrefixScan(ctx, base);
  return null;
}

/** Resolves HEAD, any branch/tag/remote-tracking name, SHA prefixes, and
 *  ~n / ^n ancestry suffixes on ANY of them ("fix~1", "origin/main~2"). */
export async function resolveRev(ctx: EngineContext, rev: string): Promise<string | null> {
  const m = /^(.+?)((?:[~^]\d*)*)$/.exec(rev);
  if (!m) return null;
  let sha = await resolveBase(ctx, m[1]);
  if (!sha) return null;
  for (const step of m[2].match(/[~^]\d*/g) ?? []) {
    const n = step.length > 1 ? Number(step.slice(1)) : 1;
    if (step[0] === '~') {
      const log = await git.log({ fs: ctx.gitFs, dir: ctx.dir, ref: sha, depth: n + 1 });
      if (log.length <= n) return null;
      sha = log[n].oid;
    } else {
      const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: sha });
      const parent = commit.parent[n - 1];
      if (!parent) return null;
      sha = parent;
    }
  }
  return sha;
}

/** First-parent chain from `tip` down to (but excluding) the first SHA in
 *  `stopAt`, newest first. Stops at the root regardless. */
export async function firstParentChain(
  ctx: EngineContext,
  tip: string,
  stopAt: Set<string>,
): Promise<string[]> {
  const chain: string[] = [];
  let cur: string | null = tip;
  while (cur && !stopAt.has(cur)) {
    chain.push(cur);
    const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: cur });
    cur = commit.parent[0] ?? null;
  }
  return chain;
}

/** Paths whose bytes differ between HEAD and `targetSha` AND carry
 *  uncommitted changes. Switching across them is what real git refuses to
 *  do ("Your local changes ... would be overwritten"). */
export async function dirtyOverlap(ctx: EngineContext, targetSha: string): Promise<string[]> {
  const [headTree, targetTree, rows] = await Promise.all([
    headTreeOids(ctx),
    treeOids(ctx, targetSha),
    statusRows(ctx),
  ]);
  const changed = new Set<string>();
  for (const p of new Set([...headTree.keys(), ...targetTree.keys()])) {
    if ((headTree.get(p) ?? null) !== (targetTree.get(p) ?? null)) changed.add(p);
  }
  return rows
    .filter(([path, h, w, s]) => changed.has(path) && !(h === 1 && w === 1 && s === 1))
    .map(([path]) => path);
}

// ---- dates ------------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatGitDate(ts: number, tzOffset: number): string {
  const sign = tzOffset < 0 ? '-' : '+';
  const abs = Math.abs(tzOffset);
  const tz = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  const d = new Date((ts + tzOffset * 60) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ` +
    `${d.getUTCFullYear()} ${tz}`
  );
}
