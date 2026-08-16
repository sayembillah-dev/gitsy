// Inspection and recovery commands (Phase 10, Act 5): reflog, blame,
// log -S (pickaxe), bisect, worktree. Real semantics over the real object
// store; the reflog itself comes from the engine journal (isomorphic-git
// keeps no reflogs), which is fed by every user-visible ref movement.

import git from 'isomorphic-git';
import { copyGitObjects } from './remote';
import {
  joinPath,
  mkdirp,
  pathExists,
  readTextFile,
  rmrf,
  type EngineContext,
} from './fsx';
import {
  addWorktree,
  clearBisect,
  readBisect,
  readReflog,
  readWorktrees,
  removeWorktree,
  writeBisect,
  type BisectState,
} from './journal';
import type { ParsedCommand } from './parser';
import { flattenTree } from './readState';
import {
  UNKNOWN_REV,
  branchSha,
  dirtyOverlap,
  fail,
  firstParentChain,
  formatGitDate,
  headInfo,
  ok,
  remoteSha,
  resolveRev,
  short,
  treeOfRef,
  type ExecOutput,
} from './refs';

type Cmd<K extends ParsedCommand['cmd']> = Extract<ParsedCommand, { cmd: K }>;

// ---- reflog -----------------------------------------------------------------

export async function execReflog(ctx: EngineContext, cmd: Cmd<'reflog'>): Promise<ExecOutput> {
  const refName = cmd.ref
    ? cmd.ref === 'HEAD'
      ? 'HEAD'
      : (await branchSha(ctx, cmd.ref))
        ? `refs/heads/${cmd.ref}`
        : cmd.ref
    : 'HEAD';
  const entries = (await readReflog(ctx)).filter((e) => e.ref === refName);
  if (entries.length === 0) return ok('');
  const display = cmd.ref ?? 'HEAD';
  const lines = entries
    .map((e, i) => `${short(e.to)} ${display}@{${entries.length - 1 - i}}: ${e.label}`)
    .reverse();
  return ok(lines.join('\n') + '\n');
}

// ---- blame --------------------------------------------------------------------

/** Line-level alignment of two texts by exact line content (LCS). Levels
 *  keep files small, so the quadratic table is fine. */
function alignLines(oldLines: string[], newLines: string[]): (number | null)[] {
  const m = oldLines.length;
  const n = newLines.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i][j] =
        oldLines[i] === newLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result: (number | null)[] = new Array(n).fill(null);
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result[j] = i;
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return result;
}

interface BlameLine {
  sha: string;
  author: string;
  timestamp: number;
  timezoneOffset: number;
  isRoot: boolean;
}

export async function execBlame(ctx: EngineContext, cmd: Cmd<'blame'>): Promise<ExecOutput> {
  const head = await headInfo(ctx);
  if (head.type === 'unborn') return fail('fatal: no commits yet; nothing to blame.\n');
  const headSha = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });

  let log;
  try {
    log = await git.log({ fs: ctx.gitFs, dir: ctx.dir, ref: headSha });
  } catch {
    return fail(`fatal: cannot read history for blame\n`);
  }
  const trees = new Map<string, Record<string, string>>();
  const treeOf = async (sha: string): Promise<Record<string, string>> => {
    const cached = trees.get(sha);
    if (cached) return cached;
    const t = await treeOfRef(ctx, sha);
    trees.set(sha, t);
    return t;
  };

  // Walk oldest to newest. A line keeps its attribution while it survives
  // verbatim; lines with no ancestor match are blamed on the commit at hand.
  const chronological = [...log].reverse();
  let prevLines: string[] = [];
  let attribution: BlameLine[] = [];
  const blameOf = (entry: (typeof chronological)[number], isRoot: boolean): BlameLine => ({
    sha: entry.oid,
    author: entry.commit.author.name,
    timestamp: entry.commit.author.timestamp,
    timezoneOffset: entry.commit.author.timezoneOffset,
    isRoot,
  });
  for (const entry of chronological) {
    const content = (await treeOf(entry.oid))[cmd.file];
    if (content === undefined) {
      prevLines = [];
      attribution = [];
      continue;
    }
    const lines = content.endsWith('\n')
      ? content.slice(0, -1).split('\n')
      : content.split('\n');
    if (prevLines.length === 0) {
      attribution = lines.map(() => blameOf(entry, entry.commit.parent.length === 0));
    } else {
      const mapping = alignLines(prevLines, lines);
      attribution = lines.map((_, j) => {
        const prev = mapping[j];
        return prev !== null && attribution[prev] ? attribution[prev] : blameOf(entry, false);
      });
    }
    prevLines = lines;
  }

  if (attribution.length === 0) {
    return fail(`fatal: no such path '${cmd.file}' in HEAD\n`);
  }

  const out = attribution.map((a, i) => {
    const sha = a.isRoot ? `^${short(a.sha)}` : short(a.sha);
    const date = formatGitDate(a.timestamp, a.timezoneOffset);
    return `${sha} (${a.author} ${date} ${i + 1}) ${prevLines[i]}`;
  });
  return ok(out.join('\n') + '\n');
}

// ---- pickaxe (log -S) ----------------------------------------------------------

/** Counts non-overlapping occurrences of needle across the whole tree. */
export function pickaxeCount(tree: Record<string, string>, needle: string): number {
  let count = 0;
  for (const content of Object.values(tree)) {
    let at = 0;
    while (true) {
      const found = content.indexOf(needle, at);
      if (found === -1) break;
      count += 1;
      at = found + needle.length;
    }
  }
  return count;
}

/** First-parent filter: commits where needle's occurrence count changed. */
export async function pickaxeFilter(
  ctx: EngineContext,
  commits: { oid: string; parent: string[] }[],
  needle: string,
): Promise<Set<string>> {
  const keep = new Set<string>();
  for (const entry of commits) {
    const tree = await treeOfRef(ctx, entry.oid);
    const here = pickaxeCount(tree, needle);
    const parentTree = entry.parent[0] ? await treeOfRef(ctx, entry.parent[0]) : {};
    const before = pickaxeCount(parentTree, needle);
    if (here !== before) keep.add(entry.oid);
  }
  return keep;
}

// ---- bisect ------------------------------------------------------------------

async function bisectAdvance(ctx: EngineContext, state: BisectState): Promise<ExecOutput> {
  if (!state.bad) return ok('status: waiting for a bad commit\n');
  if (state.good.length === 0) return ok('status: waiting for a good commit\n');
  const chain = await firstParentChain(ctx, state.bad, new Set(state.good));
  state.chain = chain;

  if (chain.length <= 1) {
    const culprit = chain[0] ?? state.bad;
    await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: culprit, force: true });
    const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: culprit });
    return ok(
      `${culprit} is the first bad commit\n` +
        `commit ${culprit}\n` +
        `    ${commit.message.split('\n')[0]}\n` +
        'hint: Gitsy leaves you ON the culprit so you can inspect it. ' +
        'Run git bisect reset (or git checkout main) to go back.\n',
    );
  }

  const mid = chain[Math.floor(chain.length / 2)];
  await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: mid, force: true });
  const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: mid });
  const left = Math.floor(chain.length / 2);
  const steps = Math.ceil(Math.log2(chain.length));
  await writeBisect(ctx, state);
  return ok(
    `Bisecting: ${left} revision${left === 1 ? '' : 's'} left to test after this ` +
      `(roughly ${steps} step${steps === 1 ? '' : 's'})\n` +
      `[${mid}] ${commit.message.split('\n')[0]}\n`,
  );
}

export async function execBisect(ctx: EngineContext, cmd: Cmd<'bisect'>): Promise<ExecOutput> {
  const existing = await readBisect(ctx);

  if (cmd.sub === 'start') {
    if (existing) {
      return fail('fatal: already bisecting.\nhint: git bisect reset stops the current search.\n');
    }
    const head = await headInfo(ctx);
    if (head.type === 'unborn') return fail('fatal: no commits yet; nothing to bisect.\n');
    const startRef: BisectState['startRef'] =
      head.type === 'branch' ? { type: 'branch', name: head.name } : { type: 'detached', sha: head.sha };
    const badSha = cmd.refs[0]
      ? await resolveRev(ctx, cmd.refs[0])
      : await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });
    if (!badSha) return fail(UNKNOWN_REV(cmd.refs[0] ?? 'HEAD'));
    const goodSha = cmd.refs[1] ? await resolveRev(ctx, cmd.refs[1]) : null;
    if (cmd.refs[1] && !goodSha) return fail(UNKNOWN_REV(cmd.refs[1]));
    const state: BisectState = {
      bad: badSha,
      good: goodSha ? [goodSha] : [],
      chain: [],
      startRef,
    };
    await writeBisect(ctx, state);
    return bisectAdvance(ctx, state);
  }

  if (!existing) return fail('fatal: not bisecting. Start with: git bisect start\n');

  if (cmd.sub === 'reset') {
    const from = await git
      .resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 })
      .catch(() => null);
    const target = cmd.refs[0] ? await resolveRev(ctx, cmd.refs[0]) : null;
    if (cmd.refs[0] && !target) return fail(UNKNOWN_REV(cmd.refs[0]));
    if (target) {
      await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: target, force: true });
    } else if (existing.startRef.type === 'branch') {
      await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: existing.startRef.name, force: true });
    } else {
      await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: existing.startRef.sha, force: true });
    }
    await clearBisect(ctx);
    const fromMsg = from ? (await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: from })).commit.message.split('\n')[0] : '';
    return ok(
      (from ? `Previous HEAD position was ${short(from)} ${fromMsg}\n` : '') +
        (existing.startRef.type === 'branch' && !target
          ? `Switched to branch '${existing.startRef.name}'\n`
          : ''),
    );
  }

  // good / bad
  const ref = cmd.refs[0];
  const sha = ref
    ? await resolveRev(ctx, ref)
    : await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });
  if (!sha) return fail(UNKNOWN_REV(ref ?? 'HEAD'));
  if (cmd.sub === 'bad') existing.bad = sha;
  else if (!existing.good.includes(sha)) existing.good.push(sha);
  return bisectAdvance(ctx, existing);
}

// ---- worktree ------------------------------------------------------------------

const sanitizeDirPart = (path: string): string =>
  path.replace(/\\/g, '/').split('/').filter(Boolean).pop()?.replace(/[^A-Za-z0-9._-]/g, '-') ??
  'worktree';

export async function execWorktree(ctx: EngineContext, cmd: Cmd<'worktree'>): Promise<ExecOutput> {
  if (cmd.sub === 'list') {
    const head = await headInfo(ctx);
    const headSha = await git
      .resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 })
      .catch(() => null);
    const mainBranch = head.type === 'branch' ? `[${head.name}]` : '(detached HEAD)';
    const lines = [`${ctx.dir}  ${headSha ? short(headSha) : '-------'} ${mainBranch}`];
    for (const w of await readWorktrees(ctx)) {
      const sha = await git
        .resolveRef({ fs: ctx.gitFs, dir: w.dir, ref: 'HEAD', depth: 10 })
        .catch(() => null);
      lines.push(`${w.path}  ${sha ? short(sha) : '-------'} [${w.branch}]`);
    }
    return ok(lines.join('\n') + '\n');
  }

  if (cmd.sub === 'remove') {
    if (!cmd.path) return fail('fatal: git worktree remove needs a path\n');
    const list = await readWorktrees(ctx);
    const entry = list.find((w) => w.path === cmd.path);
    if (!entry) return fail(`fatal: '${cmd.path}' is not a working tree\n`);
    await rmrf(ctx.fs, entry.dir);
    await removeWorktree(ctx, cmd.path);
    return ok('');
  }

  // add
  if (!cmd.path) return fail('fatal: git worktree add needs a path\n');
  const list = await readWorktrees(ctx);
  if (list.some((w) => w.path === cmd.path)) {
    return fail(`fatal: '${cmd.path}' already exists\n`);
  }
  const head = await headInfo(ctx);
  if (head.type === 'unborn') return fail('fatal: no commits yet; nothing to check out.\n');

  let branch: string;
  let sha: string | null;
  if (cmd.createBranch && cmd.branch) {
    if (await branchSha(ctx, cmd.branch)) {
      return fail(`fatal: a branch named '${cmd.branch}' already exists\n`);
    }
    branch = cmd.branch;
    sha = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });
  } else {
    branch = cmd.branch ?? sanitizeDirPart(cmd.path);
    sha = await branchSha(ctx, branch);
    if (!sha) {
      // Real git creates a branch named after the directory in this case.
      sha = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });
      await git.branch({ fs: ctx.gitFs, dir: ctx.dir, ref: branch });
    }
  }
  // The worktree takes exclusive ownership of the branch (real git's rule).
  if (head.type === 'branch' && head.name === branch) {
    return fail(`fatal: '${branch}' is already checked out at '${ctx.dir}'\n`);
  }
  if (list.some((w) => w.branch === branch)) {
    const where = list.find((w) => w.branch === branch);
    return fail(`fatal: '${branch}' is already checked out at '${where?.path}'\n`);
  }

  const wtDir = `${ctx.dir}-wt-${sanitizeDirPart(cmd.path)}`;
  await mkdirp(ctx.fs, wtDir);
  await git.init({ fs: ctx.gitFs, dir: wtDir, defaultBranch: 'main' });
  await copyGitObjects(ctx, ctx.dir, wtDir);
  if (cmd.createBranch && cmd.branch) {
    await git.branch({ fs: ctx.gitFs, dir: ctx.dir, ref: branch });
  }
  await git.writeRef({ fs: ctx.gitFs, dir: wtDir, ref: `refs/heads/${branch}`, value: sha, force: true });
  await git.checkout({ fs: ctx.gitFs, dir: wtDir, ref: branch, force: true });
  await addWorktree(ctx, { path: cmd.path, dir: wtDir, branch });

  const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: sha });
  return ok(
    `Preparing worktree (${cmd.createBranch || !cmd.branch ? `new branch '${branch}'` : `checking out '${branch}'`})\n` +
      `HEAD is now at ${short(sha)} ${commit.message.split('\n')[0]}\n`,
  );
}

/** Used by execSwitchLike: a branch owned by a linked worktree cannot be
 *  checked out in the main tree (real git's exclusivity rule). */
export async function worktreeOwner(ctx: EngineContext, branch: string): Promise<string | null> {
  const entry = (await readWorktrees(ctx)).find((w) => w.branch === branch);
  return entry ? entry.path : null;
}
