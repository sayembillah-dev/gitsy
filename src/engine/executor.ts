// Structured op to isomorphic-git calls (BUILD-PLAN section 2).
// stdout/stderr are real-git-shaped: the error text is teaching material.

import git from 'isomorphic-git';
import { buildFileDiff } from './diff';
import {
  joinPath,
  mkdirp,
  pathExists,
  readTextFile,
  writeTextFile,
  type EngineContext,
} from './fsx';
import type { ParsedCommand } from './parser';
import {
  flattenTree,
  headTreeOids,
  indexOids,
  readBlobText,
  statusRows,
  workdirFiles,
  type StatusRow,
} from './readState';

export interface ExecOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const ok = (stdout = ''): ExecOutput => ({ ok: true, stdout, stderr: '' });
const fail = (stderr: string): ExecOutput => ({ ok: false, stdout: '', stderr });
const short = (sha: string) => sha.slice(0, 7);

type Cmd<K extends ParsedCommand['cmd']> = Extract<ParsedCommand, { cmd: K }>;

export async function execute(ctx: EngineContext, cmd: ParsedCommand): Promise<ExecOutput> {
  switch (cmd.cmd) {
    case 'init':
      return execInit(ctx);
    case 'add':
      return execAdd(ctx, cmd);
    case 'commit':
      return execCommit(ctx, cmd);
    case 'status':
      return execStatus(ctx, cmd);
    case 'log':
      return execLog(ctx, cmd);
    case 'diff':
      return execDiff(ctx, cmd);
    case 'restore':
      return execRestore(ctx, cmd);
    case 'branch':
      return execBranch(ctx, cmd);
    case 'switch':
    case 'checkout':
      return execSwitchLike(ctx, cmd);
    case 'merge':
      return execMerge(ctx, cmd);
    case 'tag':
      return execTag(ctx, cmd);
    case 'unsupported':
      return fail(`${cmd.name}: not available yet. It unlocks in a later act.\n`);
  }
}

type HeadInfo =
  | { type: 'branch'; name: string }
  | { type: 'unborn'; name: string }
  | { type: 'detached'; sha: string };

async function headInfo(ctx: EngineContext): Promise<HeadInfo> {
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

const pathMatches = (path: string, filters: string[]): boolean =>
  filters.length === 0 ||
  filters.some((f) => path === f || path.startsWith(f.replace(/\/$/, '') + '/'));

// ---- init ---------------------------------------------------------------

async function execInit(ctx: EngineContext): Promise<ExecOutput> {
  await mkdirp(ctx.fs, ctx.dir);
  const existed = await pathExists(ctx.fs, joinPath(ctx.dir, '.git'));
  await git.init({ fs: ctx.gitFs, dir: ctx.dir, defaultBranch: 'main' });
  const verb = existed ? 'Reinitialized existing' : 'Initialized empty';
  return ok(`${verb} Git repository in ${joinPath(ctx.dir, '.git')}/\n`);
}

// ---- add ----------------------------------------------------------------

async function execAdd(ctx: EngineContext, cmd: Cmd<'add'>): Promise<ExecOutput> {
  if (cmd.patch) {
    return fail(
      'git add --patch needs the interactive terminal (lands in Phase 3).\n' +
        'hint: stage whole files for now with git add <pathspec>\n',
    );
  }
  const rows = await statusRows(ctx);
  const targets = rows.filter(([path, h, w, s]) => {
    if (cmd.all) return !(h === 1 && w === 1 && s === 1); // anything noteworthy
    return pathMatches(path, cmd.paths);
  });

  if (!cmd.all) {
    const idx = await indexOids(ctx);
    for (const p of cmd.paths) {
      const inMatrix = rows.some(([path]) => pathMatches(path, [p]));
      const onDisk = await pathExists(ctx.fs, joinPath(ctx.dir, p));
      if (!inMatrix && !onDisk && !idx.has(p)) {
        return fail(`fatal: pathspec '${p}' did not match any files\n`);
      }
    }
  }

  for (const [path, , w] of targets) {
    if (w === 0) await git.remove({ fs: ctx.gitFs, dir: ctx.dir, filepath: path });
    else await git.add({ fs: ctx.gitFs, dir: ctx.dir, filepath: path });
  }
  return ok();
}

// ---- commit -------------------------------------------------------------

async function execCommit(ctx: EngineContext, cmd: Cmd<'commit'>): Promise<ExecOutput> {
  if (cmd.messages.length === 0) {
    return fail(
      'error: no commit message supplied.\n' +
        'hint: use git commit -m "your message here"\n' +
        'fatal: aborting commit due to empty commit message.\n',
    );
  }

  const rows = await statusRows(ctx);
  const staged = rows.filter(([, h, , s]) => (h === 0 && s > 0) || (h === 1 && s !== 1));
  const head = await headInfo(ctx);
  const label = head.type === 'detached' ? 'HEAD' : head.name;

  // Merge finale: committing with MERGE_HEAD present creates the two-parent
  // merge commit, but only after every conflict marker is edited away. This
  // check comes before the nothing-staged refusal: real git answers
  // "unmerged files" even when the index is untouched.
  const mergeHeadPath = joinPath(ctx.dir, '.git', 'MERGE_HEAD');
  const merging = await pathExists(ctx.fs, mergeHeadPath);
  let parents: string[] | undefined;
  if (merging) {
    const workdir = await workdirFiles(ctx);
    const unmerged = [...workdir.keys()].filter((p) =>
      (workdir.get(p)?.content ?? '').includes('<<<<<<< '),
    );
    if (unmerged.length > 0) {
      return fail(
        `error: Committing is not possible because you have unmerged files.\n` +
          `fatal: Exiting because of an unresolved conflict.\n`,
      );
    }
    const theirSha = (await readTextFile(ctx.fs, mergeHeadPath)).trim();
    const headSha = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });
    parents = [headSha, theirSha];
  }

  if (staged.length === 0 && !cmd.allowEmpty && !merging) {
    const dirty = rows.some(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));
    return {
      ok: false,
      stdout:
        `On branch ${label}\n` +
        (dirty
          ? 'no changes added to commit (use "git add" to track)\n'
          : 'nothing to commit, working tree clean\n'),
      stderr: '',
    };
  }

  const message = cmd.messages.join('\n\n');
  const who = { ...ctx.author, timestamp: ctx.now(), timezoneOffset: 0 };
  const sha = await git.commit({
    fs: ctx.gitFs,
    dir: ctx.dir,
    message,
    author: who,
    committer: who,
    ...(parents ? { parent: parents } : {}),
  });
  if (merging) await ctx.fs.unlink(mergeHeadPath);
  const root = head.type === 'unborn' ? ' (root-commit)' : '';
  const n = staged.length;
  return ok(
    `[${label}${root} ${short(sha)}] ${message.split('\n')[0]}\n` +
      ` ${n} file${n === 1 ? '' : 's'} changed\n`,
  );
}

// ---- branch / switch / checkout / tag ------------------------------------

async function branchSha(ctx: EngineContext, name: string): Promise<string | null> {
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

async function execBranch(ctx: EngineContext, cmd: Cmd<'branch'>): Promise<ExecOutput> {
  const head = await headInfo(ctx);
  if (cmd.deleteName) {
    const name = cmd.deleteName;
    if (head.type === 'branch' && head.name === name) {
      return fail(`error: cannot delete branch '${name}' while you are on it\n`);
    }
    const sha = await branchSha(ctx, name);
    if (!sha) return fail(`error: branch '${name}' not found\n`);
    await git.deleteBranch({ fs: ctx.gitFs, dir: ctx.dir, ref: name });
    return ok(`Deleted branch ${name} (was ${short(sha)}).\n`);
  }
  if (cmd.name) {
    if (await branchSha(ctx, cmd.name)) {
      return fail(`fatal: a branch named '${cmd.name}' already exists\n`);
    }
    await git.branch({ fs: ctx.gitFs, dir: ctx.dir, ref: cmd.name });
    return ok('');
  }
  const names = (await git.listBranches({ fs: ctx.gitFs, dir: ctx.dir })).sort();
  const lines = names.map((n) =>
    n === (head.type === 'branch' ? head.name : null) ? `* ${n}` : `  ${n}`,
  );
  return ok(lines.join('\n') + (lines.length ? '\n' : ''));
}

async function execSwitchLike(
  ctx: EngineContext,
  cmd: Cmd<'switch'> | Cmd<'checkout'>,
): Promise<ExecOutput> {
  const verb = cmd.cmd;
  if (cmd.create) {
    if (await branchSha(ctx, cmd.name)) {
      return fail(`fatal: a branch named '${cmd.name}' already exists\n`);
    }
    await git.branch({ fs: ctx.gitFs, dir: ctx.dir, ref: cmd.name });
    await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: cmd.name });
    return ok(`Switched to a new branch '${cmd.name}'\n`);
  }
  if (!(await branchSha(ctx, cmd.name))) {
    return fail(
      verb === 'switch'
        ? `fatal: invalid reference: ${cmd.name}\n`
        : `error: pathspec '${cmd.name}' did not match any file(s) known to git\n`,
    );
  }
  await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: cmd.name });
  return ok(`Switched to branch '${cmd.name}'\n`);
}

async function execTag(ctx: EngineContext, cmd: Cmd<'tag'>): Promise<ExecOutput> {
  await git.tag({ fs: ctx.gitFs, dir: ctx.dir, ref: cmd.name });
  return ok('');
}

// ---- merge ----------------------------------------------------------------

async function treeOfRef(ctx: EngineContext, sha: string): Promise<Record<string, string>> {
  const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: sha });
  return flattenTree(ctx, commit.tree);
}

async function execMerge(ctx: EngineContext, cmd: Cmd<'merge'>): Promise<ExecOutput> {
  const head = await headInfo(ctx);
  const theirsSha = await branchSha(ctx, cmd.branch);
  if (!theirsSha) return fail(`merge: ${cmd.branch} - not something we can merge\n`);
  const oursSha =
    head.type === 'branch'
      ? await branchSha(ctx, head.name)
      : head.type === 'detached'
        ? head.sha
        : null;
  if (!oursSha) return fail('fatal: cannot merge into an unborn branch\n');

  const [oursLog, theirsLog] = await Promise.all([
    git.log({ fs: ctx.gitFs, dir: ctx.dir, ref: oursSha }),
    git.log({ fs: ctx.gitFs, dir: ctx.dir, ref: theirsSha }),
  ]);
  const oursSet = new Set(oursLog.map((e) => e.oid));
  const base = theirsLog.find((e) => oursSet.has(e.oid))?.oid ?? null;

  if (base === theirsSha) return ok('Already up to date.\n');

  if (base === oursSha) {
    // Fast-forward: move our ref, then force the workdir and index to match.
    if (head.type === 'branch') {
      await git.writeRef({
        fs: ctx.gitFs,
        dir: ctx.dir,
        ref: `refs/heads/${head.name}`,
        value: theirsSha,
        force: true,
      });
      await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: head.name, force: true });
    } else {
      await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: theirsSha, force: true });
    }
    return ok(`Updating ${short(oursSha)}..${short(theirsSha)}\nFast-forward\n`);
  }

  const [baseT, oursT, theirsT] = await Promise.all([
    base ? treeOfRef(ctx, base) : Promise.resolve({} as Record<string, string>),
    treeOfRef(ctx, oursSha),
    treeOfRef(ctx, theirsSha),
  ]);
  const paths = [
    ...new Set([...Object.keys(baseT), ...Object.keys(oursT), ...Object.keys(theirsT)]),
  ].sort();

  const changes: { path: string; content: string | null }[] = [];
  const conflicts: string[] = [];
  for (const p of paths) {
    const b = baseT[p] ?? null;
    const o = oursT[p] ?? null;
    const t = theirsT[p] ?? null;
    if (o === t) continue; // identical (or both absent)
    if (b === o) changes.push({ path: p, content: t }); // only their side moved
    else if (b === t) continue; // only our side moved
    else conflicts.push(p); // both sides moved differently
  }

  for (const change of changes) {
    if (change.content === null) {
      await ctx.fs.unlink(joinPath(ctx.dir, change.path)).catch(() => undefined);
      await git.remove({ fs: ctx.gitFs, dir: ctx.dir, filepath: change.path });
    } else {
      await writeTextFile(ctx.fs, joinPath(ctx.dir, change.path), change.content);
      await git.add({ fs: ctx.gitFs, dir: ctx.dir, filepath: change.path });
    }
  }

  if (conflicts.length === 0) {
    const who = { ...ctx.author, timestamp: ctx.now(), timezoneOffset: 0 };
    const message = `Merge branch '${cmd.branch}'`;
    await git.commit({
      fs: ctx.gitFs,
      dir: ctx.dir,
      message,
      author: who,
      committer: who,
      parent: [oursSha, theirsSha],
    });
    return ok(`Merge made by the 'ort' strategy.\n`);
  }

  for (const p of conflicts) {
    const marked =
      `<<<<<<< HEAD\n${oursT[p] ?? ''}` +
      `=======\n${theirsT[p] ?? ''}` +
      `>>>>>>> ${cmd.branch}\n`;
    await writeTextFile(ctx.fs, joinPath(ctx.dir, p), marked);
  }
  await writeTextFile(ctx.fs, joinPath(ctx.dir, '.git', 'MERGE_HEAD'), theirsSha + '\n');
  return fail(
    `Auto-merging ${conflicts.join(', ')}\n` +
      `CONFLICT (content): Merge conflict in ${conflicts[0]}\n` +
      'Automatic merge failed; fix conflicts and then commit the result.\n',
  );
}

// ---- status -------------------------------------------------------------

async function execStatus(ctx: EngineContext, cmd: Cmd<'status'>): Promise<ExecOutput> {
  const rows = await statusRows(ctx);
  const head = await headInfo(ctx);

  if (cmd.short) {
    const lines: string[] = [];
    if (cmd.showBranch) {
      lines.push(`## ${head.type === 'detached' ? 'HEAD (no branch)' : head.name}`);
    }
    for (const [path, h, w, s] of rows) {
      if (h === 0 && w === 2 && s === 0) {
        lines.push(`?? ${path}`);
        continue;
      }
      const x = h === 0 && s > 0 ? 'A' : s === 0 && h === 1 ? 'D' : s >= 2 ? 'M' : ' ';
      const y = w === 0 && s > 0 ? 'D' : w === 2 && (s === 1 || s === 3) ? 'M' : ' ';
      if (x === ' ' && y === ' ') continue;
      lines.push(`${x}${y} ${path}`);
    }
    return ok(lines.length ? lines.join('\n') + '\n' : '');
  }

  const untracked = rows.filter(([, h, w, s]) => h === 0 && w === 2 && s === 0);
  const stagedNew = rows.filter(([, h, , s]) => h === 0 && s >= 2);
  const stagedMod = rows.filter(([, h, , s]) => h === 1 && s >= 2);
  const stagedDel = rows.filter(([, h, , s]) => h === 1 && s === 0);
  const unstagedMod = rows.filter(([, , w, s]) => w === 2 && (s === 1 || s === 3));
  const unstagedDel = rows.filter(([, , w, s]) => w === 0 && s > 0);
  const stagedCount = stagedNew.length + stagedMod.length + stagedDel.length;

  const lines: string[] = [
    head.type === 'detached' ? `HEAD detached at ${short(head.sha)}` : `On branch ${head.name}`,
  ];
  if (head.type === 'unborn') lines.push('', 'No commits yet', '');

  if (stagedCount > 0) {
    lines.push('Changes to be committed:');
    if (head.type !== 'unborn') lines.push('  (use "git restore --staged <file>..." to unstage)');
    for (const [p] of stagedNew) lines.push(`\tnew file:   ${p}`);
    for (const [p] of stagedMod) lines.push(`\tmodified:   ${p}`);
    for (const [p] of stagedDel) lines.push(`\tdeleted:    ${p}`);
    lines.push('');
  }
  if (unstagedMod.length + unstagedDel.length > 0) {
    lines.push('Changes not staged for commit:');
    lines.push('  (use "git add <file>..." to update what will be committed)');
    lines.push('  (use "git restore <file>..." to discard changes in working directory)');
    for (const [p] of unstagedMod) lines.push(`\tmodified:   ${p}`);
    for (const [p] of unstagedDel) lines.push(`\tdeleted:    ${p}`);
    lines.push('');
  }
  if (untracked.length > 0) {
    lines.push('Untracked files:');
    lines.push('  (use "git add <file>..." to include in what will be committed)');
    for (const [p] of untracked) lines.push(`\t${p}`);
    lines.push('');
  }
  if (stagedCount === 0) {
    if (untracked.length > 0) {
      lines.push('nothing added to commit but untracked files present (use "git add" to track)');
    } else if (unstagedMod.length + unstagedDel.length > 0) {
      lines.push('no changes added to commit (use "git add" and/or "git commit -a")');
    } else {
      lines.push('nothing to commit, working tree clean');
    }
  }
  return ok(lines.join('\n') + '\n');
}

// ---- log ----------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatGitDate(ts: number, tzOffset: number): string {
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

async function execLog(ctx: EngineContext, cmd: Cmd<'log'>): Promise<ExecOutput> {
  const head = await headInfo(ctx);
  if (head.type === 'unborn') {
    return fail(`fatal: your current branch '${head.name}' does not have any commits yet\n`);
  }
  let commits;
  try {
    commits = await git.log({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD' });
  } catch (err) {
    return fail(`fatal: unable to read log: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  const limited = cmd.maxCount ? commits.slice(0, cmd.maxCount) : commits;
  if (cmd.oneline) {
    return ok(
      limited.map((c) => `${short(c.oid)} ${c.commit.message.split('\n')[0]}`).join('\n') + '\n',
    );
  }
  const blocks = limited.map((c) => {
    const a = c.commit.author;
    const msg = c.commit.message
      .replace(/\n+$/, '')
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n');
    return `commit ${c.oid}\nAuthor: ${a.name} <${a.email}>\nDate:   ${formatGitDate(a.timestamp, a.timezoneOffset)}\n\n${msg}`;
  });
  return ok(blocks.join('\n\n') + '\n');
}

// ---- diff ---------------------------------------------------------------

async function hashContent(ctx: EngineContext, content: string): Promise<string> {
  try {
    const { oid } = await git.hashBlob({ object: new TextEncoder().encode(content) });
    return short(oid);
  } catch {
    return '0000000';
  }
}

async function execDiff(ctx: EngineContext, cmd: Cmd<'diff'>): Promise<ExecOutput> {
  const idx = await indexOids(ctx);
  const blocks: string[] = [];

  if (cmd.staged) {
    const headTree = await headTreeOids(ctx);
    const paths = [...new Set([...headTree.keys(), ...idx.keys()])]
      .filter((p) => pathMatches(p, cmd.paths))
      .sort();
    for (const p of paths) {
      const inHead = headTree.get(p) ?? null;
      const inIdx = idx.get(p) ?? null;
      if (inHead === inIdx) continue;
      blocks.push(
        buildFileDiff({
          oldContent: inHead ? await readBlobText(ctx, inHead) : null,
          newContent: inIdx ? await readBlobText(ctx, inIdx) : null,
          oldPath: p,
          newPath: p,
          oldOid: inHead ? short(inHead) : undefined,
          newOid: inIdx ? short(inIdx) : undefined,
        }),
      );
    }
    return ok(blocks.join(''));
  }

  const rows = await statusRows(ctx);
  const changed = rows.filter(
    ([, , w, s]) => (w === 2 && (s === 1 || s === 3)) || (w === 0 && s > 0),
  );
  for (const [p, , w] of changed) {
    if (!pathMatches(p, cmd.paths)) continue;
    const inIdx = idx.get(p) ?? null;
    const newContent = w === 0 ? null : await readTextFile(ctx.fs, joinPath(ctx.dir, p));
    const oldContent = inIdx ? await readBlobText(ctx, inIdx) : null;
    if (oldContent === newContent) continue;
    blocks.push(
      buildFileDiff({
        oldContent,
        newContent,
        oldPath: p,
        newPath: p,
        oldOid: inIdx ? short(inIdx) : undefined,
        newOid: newContent !== null ? await hashContent(ctx, newContent) : undefined,
      }),
    );
  }
  return ok(blocks.join(''));
}

// ---- restore ------------------------------------------------------------

async function execRestore(ctx: EngineContext, cmd: Cmd<'restore'>): Promise<ExecOutput> {
  const idx = await indexOids(ctx);
  const headTree = await headTreeOids(ctx);

  for (const p of cmd.paths) {
    if (!idx.has(p) && !headTree.has(p)) {
      return fail(`error: pathspec '${p}' did not match any file(s) known to git\n`);
    }
  }

  if (cmd.staged) {
    for (const p of cmd.paths) {
      try {
        await git.resetIndex({ fs: ctx.gitFs, dir: ctx.dir, filepath: p });
      } catch {
        // No HEAD version to reset to (newly added file): drop from the index.
        await git.remove({ fs: ctx.gitFs, dir: ctx.dir, filepath: p });
      }
    }
  }
  if (cmd.worktree) {
    for (const p of cmd.paths) {
      const oid = idx.get(p);
      if (!oid) continue; // nothing in the index to restore from
      await writeTextFile(ctx.fs, joinPath(ctx.dir, p), await readBlobText(ctx, oid));
    }
  }
  return ok();
}
