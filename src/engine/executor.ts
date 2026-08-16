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
import { amendHead, execCherryPick, execRebase, execRevert, threeWayApply } from './history';
import {
  execBisect,
  execBlame,
  execReflog,
  execWorktree,
  pickaxeFilter,
  worktreeOwner,
} from './inspect';
import { logRef, REBASE_TODO_PATH } from './journal';
import type { ParsedCommand } from './parser';
import {
  headTreeOids,
  indexOids,
  readBlobText,
  statusRows,
  workdirFiles,
} from './readState';
import {
  branchSha,
  dirtyOverlap,
  fail,
  formatGitDate,
  headInfo,
  ok,
  remoteSha,
  resolveRev,
  short,
  treeOfRef,
  UNKNOWN_REV,
  type ExecOutput,
} from './refs';
import { execStash } from './stash';
import {
  NO_ORIGIN,
  aheadBehind,
  fetchFromOrigin,
  originExists,
  pushToOrigin,
} from './remote';

export type { ExecOutput } from './refs';

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
    case 'reset':
      return execReset(ctx, cmd);
    case 'remote':
      return execRemote(ctx, cmd);
    case 'fetch':
      return execFetch(ctx, cmd);
    case 'pull':
      return execPull(ctx, cmd);
    case 'push':
      return execPush(ctx, cmd);
    case 'revert':
      return execRevert(ctx, cmd);
    case 'cherry-pick':
      return execCherryPick(ctx, cmd);
    case 'rebase':
      return execRebase(ctx, cmd);
    case 'stash':
      return execStash(ctx, cmd);
    case 'reflog':
      return execReflog(ctx, cmd);
    case 'bisect':
      return execBisect(ctx, cmd);
    case 'blame':
      return execBlame(ctx, cmd);
    case 'worktree':
      return execWorktree(ctx, cmd);
    case 'clone':
      return fail(
        'fatal: Gitsy repositories arrive pre-cloned.\n' +
          'hint: every Act 3 level already has an origin. Run git remote -v to see it.\n',
      );
    case 'unsupported':
      return fail(`${cmd.name}: not available yet. It unlocks in a later act.\n`);
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
    // The rebase worksheet is engine bookkeeping, never commit content.
    if (path === REBASE_TODO_PATH) return false;
    if (cmd.all) return !(h === 1 && w === 1 && s === 1); // anything noteworthy
    return pathMatches(path, cmd.paths);
  });

  if (!cmd.all) {
    const idx = await indexOids(ctx);
    for (const p of cmd.paths) {
      if (p === REBASE_TODO_PATH) {
        return fail(
          `fatal: ${REBASE_TODO_PATH} is the rebase worksheet, not part of your tree\n` +
            'hint: edit it, save it, then run git rebase --continue\n',
        );
      }
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
  const mergingForAmend = await pathExists(ctx.fs, joinPath(ctx.dir, '.git', 'MERGE_HEAD'));
  if (cmd.amend) {
    if (mergingForAmend) {
      return fail('fatal: You are in the middle of a merge; cannot amend.\n');
    }
    // --amend with no -m keeps the original message (our always --no-edit).
    return amendHead(ctx, cmd.messages);
  }

  const rows = await statusRows(ctx);
  const staged = rows.filter(([, h, , s]) => (h === 0 && s > 0) || (h === 1 && s !== 1));
  const head = await headInfo(ctx);
  const label = head.type === 'detached' ? 'HEAD' : head.name;

  // Sequencer states: MERGE_HEAD (Phase 4), REVERT_HEAD and CHERRY_PICK_HEAD
  // (Phase 10). Committing with one present finishes the operation, but only
  // after every conflict marker is edited away. This check comes before the
  // nothing-staged refusal: real git answers "unmerged files" even when the
  // index is untouched.
  const sequencerPath = (name: string) => joinPath(ctx.dir, '.git', name);
  const merging = await pathExists(ctx.fs, sequencerPath('MERGE_HEAD'));
  const reverting = await pathExists(ctx.fs, sequencerPath('REVERT_HEAD'));
  const picking = await pathExists(ctx.fs, sequencerPath('CHERRY_PICK_HEAD'));
  const inSequencer = merging || reverting || picking;

  let parents: string[] | undefined;
  let sequencerMessage: string | null = null;
  if (inSequencer) {
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
    if (merging) {
      const theirSha = (await readTextFile(ctx.fs, sequencerPath('MERGE_HEAD'))).trim();
      const headSha = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });
      parents = [headSha, theirSha];
    } else {
      const msgFile = reverting ? 'REVERT_MSG' : 'CHERRY_PICK_MSG';
      sequencerMessage = (await readTextFile(ctx.fs, sequencerPath(msgFile))).trim();
    }
  }

  const message = cmd.messages.length > 0 ? cmd.messages.join('\n\n') : (sequencerMessage ?? '');
  if (message === '') {
    return fail(
      'error: no commit message supplied.\n' +
        'hint: use git commit -m "your message here"\n' +
        'fatal: aborting commit due to empty commit message.\n',
    );
  }

  if (staged.length === 0 && !cmd.allowEmpty && !inSequencer) {
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

  const previous = await git
    .resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 })
    .catch(() => null);
  const who = { ...ctx.author, timestamp: ctx.now(), timezoneOffset: 0 };
  const sha = await git.commit({
    fs: ctx.gitFs,
    dir: ctx.dir,
    message,
    author: who,
    committer: who,
    ...(parents ? { parent: parents } : {}),
  });
  if (merging) await ctx.fs.unlink(sequencerPath('MERGE_HEAD'));
  if (reverting) {
    await ctx.fs.unlink(sequencerPath('REVERT_HEAD')).catch(() => undefined);
    await ctx.fs.unlink(sequencerPath('REVERT_MSG')).catch(() => undefined);
  }
  if (picking) {
    await ctx.fs.unlink(sequencerPath('CHERRY_PICK_HEAD')).catch(() => undefined);
    await ctx.fs.unlink(sequencerPath('CHERRY_PICK_MSG')).catch(() => undefined);
  }

  // Every user-visible ref movement feeds the reflog journal (Act 5).
  const verb = merging
    ? 'commit (merge)'
    : reverting
      ? 'revert'
      : picking
        ? 'commit (cherry-pick)'
        : 'commit';
  const refName = head.type === 'branch' || head.type === 'unborn' ? `refs/heads/${head.name}` : 'HEAD';
  await logRef(ctx, refName, previous, sha, `${verb}: ${message.split('\n')[0]}`);
  if (refName !== 'HEAD') {
    await logRef(ctx, 'HEAD', previous, sha, `${verb}: ${message.split('\n')[0]}`);
  }

  const root = head.type === 'unborn' ? ' (root-commit)' : '';
  const n = staged.length;
  return ok(
    `[${label}${root} ${short(sha)}] ${message.split('\n')[0]}\n` +
      ` ${n} file${n === 1 ? '' : 's'} changed\n`,
  );
}

// ---- branch / switch / checkout / tag ------------------------------------

// ---- remote / fetch / pull / push (Phase 9) -------------------------------

async function execRemote(ctx: EngineContext, cmd: Cmd<'remote'>): Promise<ExecOutput> {
  if (!(await originExists(ctx))) return ok(''); // real git prints nothing
  if (!cmd.verbose) return ok('origin\n');
  return ok(`origin\t${ctx.originDir} (fetch)\norigin\t${ctx.originDir} (push)\n`);
}

async function execFetch(ctx: EngineContext, cmd: Cmd<'fetch'>): Promise<ExecOutput> {
  if (cmd.remote !== 'origin') {
    return fail(`fatal: '${cmd.remote}' does not appear to be a git repository\n`);
  }
  const r = await fetchFromOrigin(ctx);
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
}

async function execPull(ctx: EngineContext, cmd: Cmd<'pull'>): Promise<ExecOutput> {
  if (cmd.remote !== 'origin') {
    return fail(`fatal: '${cmd.remote}' does not appear to be a git repository\n`);
  }
  // pull = fetch + merge origin/<current>. Real git's default strategy is
  // merge; that is exactly the hand-rolled merge from Phase 4.
  const fetched = await fetchFromOrigin(ctx);
  if (!fetched.ok) return { ok: false, stdout: '', stderr: fetched.stderr };

  const head = await headInfo(ctx);
  if (head.type === 'detached') return fail('fatal: You are not currently on a branch.\n');
  const tracking = await remoteSha(ctx, `origin/${head.name}`);
  if (!tracking) {
    return fail(
      'There is no tracking information for the current branch.\n' +
        'hint: push with -u first, or fetch a branch that exists on origin\n',
    );
  }
  const merged = await execMerge(ctx, { cmd: 'merge', branch: `origin/${head.name}` });
  return {
    ok: merged.ok,
    stdout: fetched.stdout + merged.stdout,
    stderr: merged.stderr,
  };
}

async function execPush(ctx: EngineContext, cmd: Cmd<'push'>): Promise<ExecOutput> {
  const head = await headInfo(ctx);
  const branch = cmd.branch ?? (head.type === 'branch' || head.type === 'unborn' ? head.name : null);
  if (!branch) {
    return fail(
      'fatal: You are not currently on a branch.\n' +
        'hint: to push the history leading to a detached HEAD, name it: git push origin <sha>\n',
    );
  }
  const r = await pushToOrigin(ctx, {
    branch,
    force: cmd.force,
    forceWithLease: cmd.forceWithLease,
    setUpstream: cmd.setUpstream,
  });
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
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
    const from = await git
      .resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 })
      .catch(() => null);
    await git.branch({ fs: ctx.gitFs, dir: ctx.dir, ref: cmd.name });
    await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: cmd.name });
    if (from) {
      const sha = (await branchSha(ctx, cmd.name)) ?? from;
      await logRef(ctx, `refs/heads/${cmd.name}`, null, sha, `branch: Created from HEAD`);
      await logRef(ctx, 'HEAD', from, sha, `checkout: moving from ${short(from)} to ${cmd.name}`);
    }
    return ok(`Switched to a new branch '${cmd.name}'\n`);
  }

  const head = await headInfo(ctx);
  const fromSha = await git
    .resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 })
    .catch(() => null);
  const fromLabel =
    head.type === 'branch' ? head.name : fromSha ? short(fromSha) : 'HEAD';

  const wantsDetach = verb === 'switch' && (cmd as Cmd<'switch'>).detach;
  const target = wantsDetach ? null : await branchSha(ctx, cmd.name);
  if (target) {
    // A linked worktree owns its branch exclusively (real git's rule).
    const owner = await worktreeOwner(ctx, cmd.name);
    if (owner) {
      return fail(`fatal: '${cmd.name}' is already checked out at '${owner}'\n`);
    }
    // Real git refuses to move when uncommitted changes overlap the delta.
    const overlap = await dirtyOverlap(ctx, target);
    if (overlap.length > 0) {
      return fail(
        'error: Your local changes to the following files would be overwritten by checkout:\n' +
          overlap.map((p) => `\t${p}`).join('\n') +
          '\nPlease commit your changes or stash them before you switch branches.\nAborting\n',
      );
    }
    await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: cmd.name });
    if (fromSha) await logRef(ctx, 'HEAD', fromSha, target, `checkout: moving from ${fromLabel} to ${cmd.name}`);
    return ok(`Switched to branch '${cmd.name}'\n`);
  }

  // Not a branch: a commit-ish detaches HEAD. switch demands --detach;
  // checkout detaches implicitly (with the famous warning).
  const sha = await resolveRev(ctx, cmd.name);
  if (!sha) {
    return fail(
      verb === 'switch'
        ? `fatal: invalid reference: ${cmd.name}\n`
        : `error: pathspec '${cmd.name}' did not match any file(s) known to git\n`,
    );
  }
  if (verb === 'switch' && !(cmd as Cmd<'switch'>).detach) {
    return fail(
      `fatal: a branch is expected, got commit '${cmd.name}'\n` +
        `hint: if you meant to detach HEAD at that commit: git switch --detach ${cmd.name}\n`,
    );
  }
  const overlap = await dirtyOverlap(ctx, sha);
  if (overlap.length > 0) {
    return fail(
      'error: Your local changes to the following files would be overwritten by checkout:\n' +
        overlap.map((p) => `\t${p}`).join('\n') +
        '\nPlease commit your changes or stash them before you switch branches.\nAborting\n',
    );
  }
  await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: sha, force: true });
  const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: sha });
  if (fromSha) {
    await logRef(ctx, 'HEAD', fromSha, sha, `checkout: moving from ${fromLabel} to ${cmd.name}`);
  }
  return ok(
    `Note: switching to '${cmd.name}'.\n\n` +
      "You are in 'detached HEAD' state. Commits here belong to no branch;\n" +
      'create one with git switch -c <name> if you want to keep them.\n\n' +
      `HEAD is now at ${short(sha)} ${commit.message.split('\n')[0]}\n`,
  );
}

async function execTag(ctx: EngineContext, cmd: Cmd<'tag'>): Promise<ExecOutput> {
  await git.tag({ fs: ctx.gitFs, dir: ctx.dir, ref: cmd.name });
  return ok('');
}

// ---- merge ----------------------------------------------------------------

async function execMerge(ctx: EngineContext, cmd: Cmd<'merge'>): Promise<ExecOutput> {
  const head = await headInfo(ctx);
  // Local branch, then remote-tracking ref: `git merge origin/main` is how
  // pull integrates, and it works standalone too.
  const theirsSha = (await branchSha(ctx, cmd.branch)) ?? (await remoteSha(ctx, cmd.branch));
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
      await logRef(ctx, `refs/heads/${head.name}`, oursSha, theirsSha, `merge ${cmd.branch}: fast-forward`);
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
  const res = await threeWayApply(ctx, baseT, oursT, theirsT, cmd.branch);

  if (res.conflicts.length === 0) {
    const who = { ...ctx.author, timestamp: ctx.now(), timezoneOffset: 0 };
    const message = `Merge branch '${cmd.branch}'`;
    const mergeSha = await git.commit({
      fs: ctx.gitFs,
      dir: ctx.dir,
      message,
      author: who,
      committer: who,
      parent: [oursSha, theirsSha],
    });
    const refName = head.type === 'branch' ? `refs/heads/${head.name}` : 'HEAD';
    await logRef(ctx, refName, oursSha, mergeSha, `commit (merge): ${message}`);
    if (refName !== 'HEAD') await logRef(ctx, 'HEAD', oursSha, mergeSha, `commit (merge): ${message}`);
    return ok(`Merge made by the 'ort' strategy.\n`);
  }

  await writeTextFile(ctx.fs, joinPath(ctx.dir, '.git', 'MERGE_HEAD'), theirsSha + '\n');
  return fail(
    `Auto-merging ${res.conflicts.join(', ')}\n` +
      `CONFLICT (content): Merge conflict in ${res.conflicts[0]}\n` +
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
      let branchLine = `## ${head.type === 'detached' ? 'HEAD (no branch)' : head.name}`;
      if (head.type === 'branch' && (await originExists(ctx))) {
        const ab = await aheadBehind(ctx, head.name);
        if (ab) {
          branchLine += `...origin/${head.name}`;
          const bits: string[] = [];
          if (ab.ahead > 0) bits.push(`ahead ${ab.ahead}`);
          if (ab.behind > 0) bits.push(`behind ${ab.behind}`);
          if (bits.length > 0) branchLine += ` [${bits.join(', ')}]`;
        }
      }
      lines.push(branchLine);
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

  // Real git reports the remote-tracking relationship here; it is how the
  // Act 3 cliff ("origin/main is a local cache") shows up in plain text.
  if (head.type === 'branch' && (await originExists(ctx))) {
    const ab = await aheadBehind(ctx, head.name);
    if (ab) {
      const track = `origin/${head.name}`;
      if (ab.ahead === 0 && ab.behind === 0) {
        lines.push(`Your branch is up to date with '${track}'.`);
      } else if (ab.behind === 0) {
        lines.push(
          `Your branch is ahead of '${track}' by ${ab.ahead} commit${ab.ahead === 1 ? '' : 's'}.`,
          '  (use "git push" to publish your local commits)',
        );
      } else if (ab.ahead === 0) {
        lines.push(
          `Your branch is behind '${track}' by ${ab.behind} commit${ab.behind === 1 ? '' : 's'}.`,
          '  (use "git pull" to update your local branch)',
        );
      } else {
        lines.push(
          `Your branch and '${track}' have diverged,`,
          `and have ${ab.ahead} and ${ab.behind} different commits each, respectively.`,
          '  (use "git pull" if you want to integrate the remote branch with yours)',
        );
      }
      lines.push('');
    }
  }

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
  // -S<string> (the pickaxe, Act 5): keep only commits where the number of
  // occurrences of the string changed relative to the first parent.
  if (cmd.pickaxe !== null) {
    const keep = await pickaxeFilter(
      ctx,
      commits.map((c) => ({ oid: c.oid, parent: [...c.commit.parent] })),
      cmd.pickaxe,
    );
    commits = commits.filter((c) => keep.has(c.oid));
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

// ---- reset ----------------------------------------------------------------

async function execReset(ctx: EngineContext, cmd: Cmd<'reset'>): Promise<ExecOutput> {
  const head = await headInfo(ctx);
  const target = cmd.target ?? 'HEAD';
  if (head.type === 'unborn') return fail(UNKNOWN_REV(target));

  const targetSha = await resolveRev(ctx, target);
  if (!targetSha) {
    return fail(
      UNKNOWN_REV(target) +
        (target !== 'HEAD' ? 'hint: to unstage a file, use git restore --staged <file>\n' : ''),
    );
  }

  // Any reset mode abandons an in-progress merge (real git clears MERGE_HEAD).
  await ctx.fs.unlink(joinPath(ctx.dir, '.git', 'MERGE_HEAD')).catch(() => undefined);

  const previous = await git
    .resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 })
    .catch(() => null);

  // Move the ref HEAD points at (or HEAD itself when detached).
  if (head.type === 'branch') {
    await git.writeRef({
      fs: ctx.gitFs,
      dir: ctx.dir,
      ref: `refs/heads/${head.name}`,
      value: targetSha,
      force: true,
    });
  } else {
    await git.writeRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', value: targetSha, force: true });
  }
  const checkoutRef = head.type === 'branch' ? head.name : targetSha;

  // reset is the classic way history gets "lost"; it must be visible in the
  // reflog or Act 5 recovery lessons have nothing to find.
  if (previous && previous !== targetSha) {
    const refName = head.type === 'branch' ? `refs/heads/${head.name}` : 'HEAD';
    await logRef(ctx, refName, previous, targetSha, `reset: moving to ${target}`);
    if (refName !== 'HEAD') {
      await logRef(ctx, 'HEAD', previous, targetSha, `reset: moving to ${target}`);
    }
  }

  if (cmd.mode === 'soft') return ok(); // ref moved; index and workdir untouched

  if (cmd.mode === 'hard') {
    await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: checkoutRef, force: true });
    const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: targetSha });
    return ok(`HEAD is now at ${short(targetSha)} ${commit.message.split('\n')[0]}\n`);
  }

  // --mixed: the index takes the target tree while the workdir keeps its
  // bytes. checkout --force resets BOTH, so snapshot the workdir first and
  // put it back afterwards. Statuses are content-hash based, which makes
  // this restore exact (the Phase 1 statusMatrix trap does not apply).
  const before = await workdirFiles(ctx);
  await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: checkoutRef, force: true });
  const after = await workdirFiles(ctx);
  for (const path of after.keys()) {
    if (!before.has(path)) {
      await ctx.fs.unlink(joinPath(ctx.dir, path)).catch(() => undefined);
    }
  }
  for (const [path, file] of before) {
    if (after.get(path)?.oid !== file.oid) {
      await writeTextFile(ctx.fs, joinPath(ctx.dir, path), file.content);
    }
  }

  // Real git reports what is now unstaged relative to the reset index.
  const rows = await statusRows(ctx);
  const lines: string[] = [];
  for (const [path, , w, s] of rows) {
    if (w === 2 && (s === 1 || s === 3)) lines.push(`M\t${path}`);
    else if (w === 0 && s > 0) lines.push(`D\t${path}`);
  }
  if (lines.length === 0) return ok();
  return ok(`Unstaged changes after reset:\n${lines.join('\n')}\n`);
}
