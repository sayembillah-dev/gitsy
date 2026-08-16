// History rewriting (Phase 10, Act 4): amend, revert, cherry-pick, rebase.
// Everything here is built on one three-way apply (the same semantics Phase
// 4's merge uses) plus git.commit with explicit parents. Rewriting commands
// return a SHA-level rewrites map; createEngine converts it to the frozen
// contract's StructHash map so the graph can morph instead of pop.

import git from 'isomorphic-git';
import {
  joinPath,
  pathExists,
  readTextFile,
  writeTextFile,
  type EngineContext,
} from './fsx';
import {
  REBASE_TODO_PATH,
  clearRebase,
  logRef,
  readRebase,
  writeRebase,
  type RebaseState,
  type RebaseStep,
} from './journal';
import type { ParsedCommand } from './parser';
import { statusRows, workdirFiles } from './readState';
import {
  UNKNOWN_REV,
  branchSha,
  fail,
  firstParentChain,
  formatGitDate,
  headInfo,
  ok,
  resolveRev,
  short,
  treeOfRef,
  type ExecOutput,
} from './refs';

type Cmd<K extends ParsedCommand['cmd']> = Extract<ParsedCommand, { cmd: K }>;

const firstLine = (message: string): string => message.split('\n')[0];
const stripEnd = (message: string): string => message.replace(/\n+$/, '');

const nowWho = (ctx: EngineContext) => ({
  ...ctx.author,
  timestamp: ctx.now(),
  timezoneOffset: 0,
});

/** Files changed between two commits' trees (for "[branch sha] msg" output). */
async function filesChanged(ctx: EngineContext, fromSha: string | null, toSha: string): Promise<number> {
  const from = fromSha ? await treeOfRef(ctx, fromSha) : {};
  const to = await treeOfRef(ctx, toSha);
  let n = 0;
  for (const p of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if ((from[p] ?? null) !== (to[p] ?? null)) n += 1;
  }
  return n;
}

// ---- the one three-way apply ----------------------------------------------

export interface ThreeWayResult {
  conflicts: string[];
  changed: number;
}

/**
 * Classic three-way file merge against the LIVE workdir and index. Clean
 * hunks land staged; conflicts land as marker files in the workdir and are
 * reported. Shared by merge (executor), revert, cherry-pick, and rebase.
 */
export async function threeWayApply(
  ctx: EngineContext,
  baseT: Record<string, string>,
  oursT: Record<string, string>,
  theirsT: Record<string, string>,
  markerLabel: string,
): Promise<ThreeWayResult> {
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

  for (const p of conflicts) {
    const marked =
      `<<<<<<< HEAD\n${oursT[p] ?? ''}` + `=======\n${theirsT[p] ?? ''}` + `>>>>>>> ${markerLabel}\n`;
    await writeTextFile(ctx.fs, joinPath(ctx.dir, p), marked);
  }
  return { conflicts, changed: changes.length };
}

const conflictText = (verb: string, conflicts: string[], sha: string, message: string): string =>
  `Auto-merging ${conflicts.join(', ')}\n` +
  `CONFLICT (content): Merge conflict in ${conflicts[0]}\n` +
  `error: could not ${verb} ${short(sha)}... ${firstLine(message)}\n` +
  'hint: fix the conflicted files, git add them, then git commit to finish.\n' +
  `Could not ${verb} ${short(sha)}... ${firstLine(message)}\n`;

// ---- commit --amend ---------------------------------------------------------

/** Replaces the HEAD commit: same parents, tree from the current index,
 *  message from -m or the original. The abandoned original stays in the
 *  object store (and the reflog), which is exactly the Act 4 cliff. */
export async function amendHead(ctx: EngineContext, messages: string[]): Promise<ExecOutput> {
  const head = await headInfo(ctx);
  if (head.type === 'unborn') return fail('fatal: You have nothing to amend.\n');
  const headSha = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });
  const { commit: old } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: headSha });
  const message = messages.length > 0 ? messages.join('\n\n') : stripEnd(old.message);
  const who = nowWho(ctx);
  const newSha = await git.commit({
    fs: ctx.gitFs,
    dir: ctx.dir,
    message,
    author: who,
    committer: who,
    parent: [...old.parent],
  });
  const label = `commit (amend): ${firstLine(message)}`;
  const refName = head.type === 'branch' ? `refs/heads/${head.name}` : 'HEAD';
  await logRef(ctx, refName, headSha, newSha, label);
  if (refName !== 'HEAD') await logRef(ctx, 'HEAD', headSha, newSha, label);
  const n = await filesChanged(ctx, old.parent[0] ?? null, newSha);
  return {
    ok: true,
    stdout:
      `[${head.type === 'branch' ? head.name : 'HEAD'} ${short(newSha)}] ${firstLine(message)}\n` +
      ` ${n} file${n === 1 ? '' : 's'} changed\n`,
    stderr: '',
    rewrites: { [headSha]: newSha },
  };
}

// ---- revert -----------------------------------------------------------------

export async function execRevert(ctx: EngineContext, cmd: Cmd<'revert'>): Promise<ExecOutput> {
  const head = await headInfo(ctx);
  if (head.type === 'unborn') return fail('fatal: You have nothing to revert on top of.\n');
  const targetSha = await resolveRev(ctx, cmd.ref);
  if (!targetSha) return fail(UNKNOWN_REV(cmd.ref));
  const { commit: target } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: targetSha });
  if (target.parent.length > 1) {
    return fail('fatal: reverting merge commits is not supported in Gitsy\n');
  }
  const headSha = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });

  // Revert is a three-way where "theirs" is the target's PARENT: the
  // anti-change. base = target, ours = HEAD, theirs = parent.
  const [baseT, oursT, theirsT] = await Promise.all([
    treeOfRef(ctx, targetSha),
    treeOfRef(ctx, headSha),
    target.parent[0] ? treeOfRef(ctx, target.parent[0]) : Promise.resolve({} as Record<string, string>),
  ]);
  const res = await threeWayApply(ctx, baseT, oursT, theirsT, `parent of ${short(targetSha)} (${firstLine(target.message)})`);
  // Single-line default message: commitReachable teaches by message equality.
  const message = `Revert "${firstLine(target.message)}"`;
  if (res.conflicts.length > 0) {
    await writeTextFile(ctx.fs, joinPath(ctx.dir, '.git', 'REVERT_HEAD'), targetSha + '\n');
    await writeTextFile(ctx.fs, joinPath(ctx.dir, '.git', 'REVERT_MSG'), message + '\n');
    return fail(conflictText('revert', res.conflicts, targetSha, target.message));
  }
  const who = nowWho(ctx);
  const newSha = await git.commit({
    fs: ctx.gitFs,
    dir: ctx.dir,
    message,
    author: who,
    committer: who,
  });
  const refName = head.type === 'branch' ? `refs/heads/${head.name}` : 'HEAD';
  await logRef(ctx, refName, headSha, newSha, `revert: ${message}`);
  if (refName !== 'HEAD') await logRef(ctx, 'HEAD', headSha, newSha, `revert: ${message}`);
  return ok(
    `[${head.type === 'branch' ? head.name : 'HEAD'} ${short(newSha)}] ${message}\n` +
      ` ${res.changed} file${res.changed === 1 ? '' : 's'} changed\n`,
  );
}

// ---- cherry-pick --------------------------------------------------------------

export async function execCherryPick(ctx: EngineContext, cmd: Cmd<'cherry-pick'>): Promise<ExecOutput> {
  const head = await headInfo(ctx);
  if (head.type === 'unborn') return fail('fatal: You have nothing to cherry-pick onto.\n');
  const targetSha = await resolveRev(ctx, cmd.ref);
  if (!targetSha) return fail(UNKNOWN_REV(cmd.ref));
  const { commit: target } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: targetSha });
  if (target.parent.length > 1) {
    return fail('fatal: cherry-picking merge commits is not supported in Gitsy\n');
  }
  const headSha = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });

  // Cherry-pick applies the target's own diff onto HEAD: base = target's
  // parent, ours = HEAD, theirs = target.
  const [baseT, oursT, theirsT] = await Promise.all([
    target.parent[0] ? treeOfRef(ctx, target.parent[0]) : Promise.resolve({} as Record<string, string>),
    treeOfRef(ctx, headSha),
    treeOfRef(ctx, targetSha),
  ]);
  const res = await threeWayApply(ctx, baseT, oursT, theirsT, `${short(targetSha)} (${firstLine(target.message)})`);
  const message = stripEnd(target.message);
  if (res.conflicts.length > 0) {
    await writeTextFile(ctx.fs, joinPath(ctx.dir, '.git', 'CHERRY_PICK_HEAD'), targetSha + '\n');
    await writeTextFile(ctx.fs, joinPath(ctx.dir, '.git', 'CHERRY_PICK_MSG'), message + '\n');
    return fail(conflictText('apply', res.conflicts, targetSha, target.message));
  }
  // Real cherry-pick keeps the original author (and date); you are only the
  // committer. The structural hash ignores authorship either way.
  const newSha = await git.commit({
    fs: ctx.gitFs,
    dir: ctx.dir,
    message,
    author: target.author,
    committer: nowWho(ctx),
  });
  const refName = head.type === 'branch' ? `refs/heads/${head.name}` : 'HEAD';
  await logRef(ctx, refName, headSha, newSha, `commit (cherry-pick): ${firstLine(message)}`);
  if (refName !== 'HEAD') await logRef(ctx, 'HEAD', headSha, newSha, `commit (cherry-pick): ${firstLine(message)}`);
  return ok(
    `[${head.type === 'branch' ? head.name : 'HEAD'} ${short(newSha)}] ${firstLine(message)}\n` +
      ` Date: ${formatGitDate(target.author.timestamp, target.author.timezoneOffset)}\n` +
      ` ${res.changed} file${res.changed === 1 ? '' : 's'} changed\n`,
  );
}

// ---- rebase -------------------------------------------------------------------

const REBASE_USAGE =
  'usage: git rebase [-i] [--onto <newbase>] [<upstream> [<branch>]]\n' +
  '   or: git rebase (--continue | --abort)';

/** Guard every rebase entry point: nothing in flight, and a clean tracked
 *  tree (real git refuses to rebase with unstaged or staged changes). */
async function rebasePrecheck(ctx: EngineContext): Promise<ExecOutput | null> {
  if (await readRebase(ctx)) {
    return fail(
      'fatal: rebase already in progress.\n' +
        'hint: run git rebase --continue to finish it, or git rebase --abort to go back.\n',
    );
  }
  const rows = await statusRows(ctx);
  const dirty = rows.some(
    ([p, h, w, s]) =>
      p !== REBASE_TODO_PATH && ((h === 1 && (w !== 1 || s !== 1)) || (h === 0 && s > 0)),
  );
  if (dirty) {
    return fail(
      'error: cannot rebase: You have unstaged changes.\n' +
        'error: Please commit or stash them.\n',
    );
  }
  return null;
}

export async function execRebase(ctx: EngineContext, cmd: Cmd<'rebase'>): Promise<ExecOutput> {
  if (cmd.abort) return abortRebase(ctx);
  if (cmd.continueRebase) return continueRebase(ctx);

  const blocked = await rebasePrecheck(ctx);
  if (blocked) return blocked;
  if (!cmd.upstream) return fail(REBASE_USAGE + '\n');

  const ontoSha = await resolveRev(ctx, cmd.upstream);
  if (!ontoSha) return fail(UNKNOWN_REV(cmd.upstream));
  const ontoFinal = cmd.onto ? await resolveRev(ctx, cmd.onto) : ontoSha;
  if (cmd.onto && !ontoFinal) return fail(UNKNOWN_REV(cmd.onto));

  const head = await headInfo(ctx);
  const branch = cmd.branch ?? (head.type === 'branch' ? head.name : null);
  if (cmd.branch && !(await branchSha(ctx, cmd.branch))) {
    return fail(`fatal: no such branch: ${cmd.branch}\n`);
  }
  const startTip =
    branch !== null
      ? head.type === 'branch' && head.name === branch
        ? await branchSha(ctx, branch)
        : await branchSha(ctx, branch)
      : head.type === 'detached'
        ? head.sha
        : null;
  if (!startTip) return fail('fatal: cannot rebase an unborn branch\n');

  // The candidate set: first-parent commits on the branch that are NOT
  // already reachable from upstream. Reversed below into replay order.
  const upstreamLog = await git.log({ fs: ctx.gitFs, dir: ctx.dir, ref: ontoSha });
  const upstreamSet = new Set(upstreamLog.map((e) => e.oid));
  const newestFirst = await firstParentChain(ctx, startTip, upstreamSet);

  if (newestFirst.length === 0) {
    const tipLog = await git.log({ fs: ctx.gitFs, dir: ctx.dir, ref: startTip });
    if (tipLog.some((e) => e.oid === ontoSha)) {
      return ok(`Current branch ${branch ?? 'HEAD'} is up to date.\n`);
    }
    // upstream is strictly ahead: rebase fast-forwards.
    if (branch) {
      await git.writeRef({
        fs: ctx.gitFs,
        dir: ctx.dir,
        ref: `refs/heads/${branch}`,
        value: ontoSha,
        force: true,
      });
      await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: branch, force: true });
      await logRef(ctx, `refs/heads/${branch}`, startTip, ontoSha, `rebase (finish): returning to refs/heads/${branch}`);
    } else {
      await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: ontoSha, force: true });
    }
    return ok(`Successfully rebased and updated ${branch ? `refs/heads/${branch}` : 'detached HEAD'}.\n`);
  }

  const candidates: RebaseStep[] = [];
  for (const sha of [...newestFirst].reverse()) {
    const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: sha });
    if (commit.parent.length > 1) {
      return fail('fatal: Gitsy rebase replays linear history; a merge commit is in the way\n');
    }
    candidates.push({ sha, message: stripEnd(commit.message), verb: 'pick' });
  }

  const state: RebaseState = {
    onto: ontoFinal as string,
    branch,
    originalTip: startTip,
    remaining: [],
    pending: null,
    lastPick: null,
    squashMessage: null,
    rewrites: {},
    todoPending: false,
    candidates,
  };

  if (cmd.interactive) {
    // The todo list is a real workdir file so the editor surface can open
    // it. --continue parses it; deleting a line drops the commit.
    state.todoPending = true;
    await writeRebase(ctx, state);
    const lines = candidates.map((s) => `pick ${short(s.sha)} ${firstLine(s.message)}`);
    const sheet =
      lines.join('\n') +
      '\n\n# Rebase worksheet. One line per commit, OLDEST first.\n' +
      '# verbs: pick (keep), squash (fold into the commit above),\n' +
      '#        drop (remove), reword <sha> <new message> (keep, rename).\n' +
      '# Delete a line to drop the commit. Save, then: git rebase --continue\n';
    await writeTextFile(ctx.fs, joinPath(ctx.dir, REBASE_TODO_PATH), sheet);
    return ok(
      'The rebase worksheet is open as REBASE_TODO in your editor.\n' +
        'Set a verb per commit (pick, squash, drop, reword), save the file,\n' +
        'then run: git rebase --continue\n',
    );
  }

  return runPlan(ctx, state, candidates, true);
}

/** Replays plan steps onto state.onto. When `fresh`, HEAD first detaches to
 *  the onto tip; on resume after a conflict, HEAD is already the tip. */
async function runPlan(
  ctx: EngineContext,
  state: RebaseState,
  plan: RebaseStep[],
  fresh: boolean,
): Promise<ExecOutput> {
  if (fresh) {
    const headSha = await git
      .resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 })
      .catch(() => null);
    await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: state.onto, force: true });
    if (headSha && headSha !== state.onto) {
      const ontoMsg = await firstLineOf(ctx, state.onto);
      await logRef(ctx, 'HEAD', headSha, state.onto, `rebase (start): checkout ${ontoMsg}`);
    }
  }

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    if (step.verb === 'drop') continue;
    const tip = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });
    const { commit: orig } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: step.sha });
    const [baseT, oursT, theirsT] = await Promise.all([
      orig.parent[0] ? treeOfRef(ctx, orig.parent[0]) : Promise.resolve({} as Record<string, string>),
      treeOfRef(ctx, tip),
      treeOfRef(ctx, step.sha),
    ]);
    const res = await threeWayApply(
      ctx,
      baseT,
      oursT,
      theirsT,
      `${short(step.sha)} (${firstLine(step.message)})`,
    );
    if (res.conflicts.length > 0) {
      state.remaining = plan.slice(i + 1);
      state.pending = step;
      await writeRebase(ctx, state);
      return {
        ...fail(
          `Auto-merging ${res.conflicts.join(', ')}\n` +
            `CONFLICT (content): Merge conflict in ${res.conflicts[0]}\n` +
            `error: could not apply ${short(step.sha)}... ${firstLine(step.message)}\n` +
            'hint: fix the conflicted files, git add them, then run git rebase --continue.\n' +
            'hint: to give up and go back to where you started: git rebase --abort.\n' +
            `Could not apply ${short(step.sha)}... ${firstLine(step.message)}\n`,
        ),
        rewrites: state.rewrites,
      };
    }

    if (step.verb === 'squash') {
      // Fold into the tip commit: same parents as the tip, merged tree
      // (already staged by threeWayApply), combined message.
      const { commit: tipCommit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: tip });
      const combined = `${state.squashMessage ?? stripEnd(tipCommit.message)}\n\n${step.message}`;
      const newSha = await git.commit({
        fs: ctx.gitFs,
        dir: ctx.dir,
        message: combined,
        author: orig.author,
        committer: nowWho(ctx),
        parent: [...tipCommit.parent],
      });
      state.rewrites[step.sha] = newSha;
      if (state.lastPick) state.rewrites[state.lastPick] = newSha;
      state.squashMessage = combined;
      await logRef(ctx, 'HEAD', tip, newSha, `rebase (squash): ${firstLine(step.message)}`);
    } else {
      const message =
        step.verb === 'reword' && step.rewordMessage ? step.rewordMessage : step.message;
      const newSha = await git.commit({
        fs: ctx.gitFs,
        dir: ctx.dir,
        message,
        author: orig.author,
        committer: nowWho(ctx),
      });
      state.rewrites[step.sha] = newSha;
      state.lastPick = step.sha;
      state.squashMessage = message;
      await logRef(ctx, 'HEAD', tip, newSha, `rebase (${step.verb}): ${firstLine(message)}`);
    }
  }
  return finishRebase(ctx, state);
}

async function finishRebase(ctx: EngineContext, state: RebaseState): Promise<ExecOutput> {
  const tip = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });
  if (state.branch) {
    await git.writeRef({
      fs: ctx.gitFs,
      dir: ctx.dir,
      ref: `refs/heads/${state.branch}`,
      value: tip,
      force: true,
    });
    await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: state.branch, force: true });
    await logRef(
      ctx,
      `refs/heads/${state.branch}`,
      state.originalTip,
      tip,
      `rebase (finish): returning to refs/heads/${state.branch}`,
    );
  }
  await clearRebase(ctx);
  await ctx.fs.unlink(joinPath(ctx.dir, REBASE_TODO_PATH)).catch(() => undefined);
  return {
    ok: true,
    stdout: `Successfully rebased and updated ${state.branch ? `refs/heads/${state.branch}` : 'detached HEAD'}.\n`,
    stderr: '',
    rewrites: state.rewrites,
  };
}

async function firstLineOf(ctx: EngineContext, sha: string): Promise<string> {
  const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: sha });
  return firstLine(commit.message);
}

const TODO_VERBS: Record<string, RebaseStep['verb']> = {
  pick: 'pick',
  p: 'pick',
  squash: 'squash',
  s: 'squash',
  drop: 'drop',
  d: 'drop',
  reword: 'reword',
  r: 'reword',
};

/** Parses the REBASE_TODO worksheet. Strict on SHAs (each line must name a
 *  rebase candidate, once); candidates with no surviving line are dropped. */
function parseTodo(
  text: string,
  candidates: RebaseStep[],
): { ok: true; steps: RebaseStep[] } | { ok: false; stderr: string } {
  const steps: RebaseStep[] = [];
  const used = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(\S+)\s+([0-9a-f]{4,40})(?:\s+(.*))?$/.exec(line);
    if (!m) return { ok: false, stderr: `error: invalid line ${i + 1}: ${line}\n` };
    const verb = TODO_VERBS[m[1]];
    if (!verb) {
      return {
        ok: false,
        stderr: `error: unknown verb '${m[1]}' on line ${i + 1}\nhint: use pick, squash, drop, or reword\n`,
      };
    }
    const candidate = candidates.find((c) => c.sha.startsWith(m[2]));
    if (!candidate) {
      return {
        ok: false,
        stderr: `error: line ${i + 1} names a commit outside this rebase: ${m[2]}\n`,
      };
    }
    if (used.has(candidate.sha)) {
      return { ok: false, stderr: `error: commit ${short(candidate.sha)} appears twice in the todo list\n` };
    }
    used.add(candidate.sha);
    const rest = (m[3] ?? '').trim();
    if (verb === 'reword' && rest === '') {
      return {
        ok: false,
        stderr: `error: reword on line ${i + 1} needs the new message on the same line:\n  reword ${m[2]} <new message>\n`,
      };
    }
    steps.push({
      sha: candidate.sha,
      message: candidate.message,
      verb,
      ...(verb === 'reword' ? { rewordMessage: rest } : {}),
    });
  }
  const firstKept = steps.find((s) => s.verb !== 'drop');
  if (firstKept?.verb === 'squash') {
    return {
      ok: false,
      stderr: "error: cannot 'squash' without a previous commit\nhint: the first kept line must be pick or reword\n",
    };
  }
  return { ok: true, steps };
}

async function continueRebase(ctx: EngineContext): Promise<ExecOutput> {
  const state = await readRebase(ctx);
  if (!state) return fail('fatal: no rebase in progress\n');

  if (state.todoPending) {
    const todoPath = joinPath(ctx.dir, REBASE_TODO_PATH);
    if (!(await pathExists(ctx.fs, todoPath))) {
      return fail(
        `fatal: ${REBASE_TODO_PATH} is missing.\n` +
          'hint: the worksheet is how -i knows your plan. Run git rebase --abort to give up.\n',
      );
    }
    const parsed = parseTodo(await readTextFile(ctx.fs, todoPath), state.candidates);
    if (!parsed.ok) return fail(parsed.stderr); // state stays todoPending; edit and retry
    await ctx.fs.unlink(todoPath).catch(() => undefined);
    state.todoPending = false;
    await writeRebase(ctx, state);
    return runPlan(ctx, state, parsed.steps, true);
  }

  if (!state.pending) return fail('fatal: no rebase step is waiting to continue\n');

  // A conflicted step resumes here: markers must be edited away first.
  const workdir = await workdirFiles(ctx);
  const unmerged = [...workdir.keys()].filter((p) =>
    (workdir.get(p)?.content ?? '').includes('<<<<<<< '),
  );
  if (unmerged.length > 0) {
    return fail(
      'error: Committing is not possible because you have unmerged files.\n' +
        'hint: fix the conflict, git add the files, then git rebase --continue.\n' +
        'fatal: Exiting because of an unresolved conflict.\n',
    );
  }
  const step = state.pending;
  const { commit: orig } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: step.sha });
  const tip = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });

  if (step.verb === 'squash') {
    const { commit: tipCommit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: tip });
    const combined = `${state.squashMessage ?? stripEnd(tipCommit.message)}\n\n${step.message}`;
    const newSha = await git.commit({
      fs: ctx.gitFs,
      dir: ctx.dir,
      message: combined,
      author: orig.author,
      committer: nowWho(ctx),
      parent: [...tipCommit.parent],
    });
    state.rewrites[step.sha] = newSha;
    if (state.lastPick) state.rewrites[state.lastPick] = newSha;
    state.squashMessage = combined;
    await logRef(ctx, 'HEAD', tip, newSha, `rebase (squash): ${firstLine(step.message)}`);
  } else {
    const message =
      step.verb === 'reword' && step.rewordMessage ? step.rewordMessage : step.message;
    const newSha = await git.commit({
      fs: ctx.gitFs,
      dir: ctx.dir,
      message,
      author: orig.author,
      committer: nowWho(ctx),
    });
    state.rewrites[step.sha] = newSha;
    state.lastPick = step.sha;
    state.squashMessage = message;
    await logRef(ctx, 'HEAD', tip, newSha, `rebase (${step.verb}): ${firstLine(message)}`);
  }

  state.pending = null;
  const remaining = state.remaining;
  state.remaining = [];
  await writeRebase(ctx, state);
  if (remaining.length === 0) return finishRebase(ctx, state);
  return runPlan(ctx, state, remaining, false);
}

async function abortRebase(ctx: EngineContext): Promise<ExecOutput> {
  const state = await readRebase(ctx);
  if (!state) return fail('fatal: no rebase in progress\n');
  const headSha = await git
    .resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 })
    .catch(() => null);
  if (state.branch) {
    await git.writeRef({
      fs: ctx.gitFs,
      dir: ctx.dir,
      ref: `refs/heads/${state.branch}`,
      value: state.originalTip,
      force: true,
    });
    await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: state.branch, force: true });
  } else {
    await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: state.originalTip, force: true });
  }
  if (headSha && headSha !== state.originalTip) {
    await logRef(ctx, 'HEAD', headSha, state.originalTip, 'rebase (abort)');
  }
  await clearRebase(ctx);
  await ctx.fs.unlink(joinPath(ctx.dir, REBASE_TODO_PATH)).catch(() => undefined);
  return ok('');
}
