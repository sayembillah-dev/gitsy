// git stash (Phase 10, Act 4). The stash commit is a REAL commit object
// (parent: the pre-stash HEAD, tree: the full tracked workdir state), stored
// dangling and tracked by the journal's stash stack. Push = commit, move the
// branch back, hard-reset. Pop/apply = write the stashed bytes back into the
// workdir (unstaged, exactly like real git's default).

import git from 'isomorphic-git';
import { joinPath, writeTextFile, type EngineContext } from './fsx';
import { logRef, popStash, pushStash, readStashStack } from './journal';
import type { ParsedCommand } from './parser';
import { statusRows } from './readState';
import { fail, headInfo, ok, short, treeOfRef, type ExecOutput } from './refs';

type Cmd<K extends ParsedCommand['cmd']> = Extract<ParsedCommand, { cmd: K }>;

export async function execStash(ctx: EngineContext, cmd: Cmd<'stash'>): Promise<ExecOutput> {
  switch (cmd.sub) {
    case 'push':
      return stashPush(ctx, cmd.message);
    case 'list':
      return stashList(ctx);
    case 'pop':
      return stashApply(ctx, true);
    case 'apply':
      return stashApply(ctx, false);
    case 'drop':
      return stashDrop(ctx);
  }
}

async function stashPush(ctx: EngineContext, message: string | null): Promise<ExecOutput> {
  const head = await headInfo(ctx);
  if (head.type === 'unborn') {
    return fail('fatal: You do not have any commits yet; there is nothing to stash onto.\n');
  }
  const headSha = await git.resolveRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', depth: 10 });

  const rows = await statusRows(ctx);
  // Real git stashes tracked changes only (untracked files stay put).
  const trackedDirty = rows.filter(
    ([, h, w, s]) => (h === 1 && (w !== 1 || s !== 1)) || (h === 0 && s > 0),
  );
  if (trackedDirty.length === 0) return ok('No local changes to save\n');

  const { commit: headCommit } = await git.readCommit({
    fs: ctx.gitFs,
    dir: ctx.dir,
    oid: headSha,
  });
  const label =
    message ??
    `WIP on ${head.type === 'branch' ? head.name : 'HEAD'}: ${short(headSha)} ${headCommit.message.split('\n')[0]}`;

  // Stage every tracked change, commit the result (this moves the branch),
  // then move the branch back and hard-reset. The commit object stays in the
  // store, dangling, exactly like real git's stash commit.
  for (const [path, , w] of trackedDirty) {
    if (w === 0) await git.remove({ fs: ctx.gitFs, dir: ctx.dir, filepath: path });
    else await git.add({ fs: ctx.gitFs, dir: ctx.dir, filepath: path });
  }
  const who = { ...ctx.author, timestamp: ctx.now(), timezoneOffset: 0 };
  const stashSha = await git.commit({
    fs: ctx.gitFs,
    dir: ctx.dir,
    message: label,
    author: who,
    committer: who,
  });
  if (head.type === 'branch') {
    await git.writeRef({
      fs: ctx.gitFs,
      dir: ctx.dir,
      ref: `refs/heads/${head.name}`,
      value: headSha,
      force: true,
    });
    await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: head.name, force: true });
  } else {
    await git.writeRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'HEAD', value: headSha, force: true });
    await git.checkout({ fs: ctx.gitFs, dir: ctx.dir, ref: headSha, force: true });
  }

  const stack = await readStashStack(ctx);
  const previous = stack[stack.length - 1]?.sha ?? null;
  await pushStash(ctx, { sha: stashSha, message: label });
  await git.writeRef({
    fs: ctx.gitFs,
    dir: ctx.dir,
    ref: 'refs/stash',
    value: stashSha,
    force: true,
  });
  await logRef(ctx, 'refs/stash', previous, stashSha, label);
  return ok(`Saved working directory and index state ${label}\n`);
}

async function stashList(ctx: EngineContext): Promise<ExecOutput> {
  const stack = await readStashStack(ctx);
  const lines = stack
    .map((entry, i) => `stash@{${stack.length - 1 - i}}: ${entry.message}`)
    .reverse();
  return ok(lines.length ? lines.join('\n') + '\n' : '');
}

/** Files the stash touches: paths whose content differs between the stash
 *  commit's tree and its parent's tree (plus parent-only deletions). */
async function stashChanges(
  ctx: EngineContext,
  stashSha: string,
): Promise<{ path: string; content: string | null }[]> {
  const { commit } = await git.readCommit({ fs: ctx.gitFs, dir: ctx.dir, oid: stashSha });
  const stashT = await treeOfRef(ctx, stashSha);
  const baseT = commit.parent[0] ? await treeOfRef(ctx, commit.parent[0]) : {};
  const paths = [...new Set([...Object.keys(baseT), ...Object.keys(stashT)])].sort();
  const out: { path: string; content: string | null }[] = [];
  for (const p of paths) {
    const b = baseT[p] ?? null;
    const s = stashT[p] ?? null;
    if (b !== s) out.push({ path: p, content: s });
  }
  return out;
}

async function stashApply(ctx: EngineContext, pop: boolean): Promise<ExecOutput> {
  const stack = await readStashStack(ctx);
  const entry = stack[stack.length - 1];
  if (!entry) return fail('No stash entries found.\n');

  for (const change of await stashChanges(ctx, entry.sha)) {
    if (change.content === null) {
      await ctx.fs.unlink(joinPath(ctx.dir, change.path)).catch(() => undefined);
    } else {
      await writeTextFile(ctx.fs, joinPath(ctx.dir, change.path), change.content);
    }
  }
  const head = await headInfo(ctx);
  const files = (await stashChanges(ctx, entry.sha)).map((c) => `\tmodified:   ${c.path}`);
  const status =
    `On branch ${head.type === 'branch' ? head.name : 'HEAD'}\n` +
    'Changes not staged for commit:\n' +
    '  (use "git add <file>..." to update what will be committed)\n' +
    files.join('\n') +
    '\n';

  if (!pop) return ok(status + '\n');

  await popStash(ctx);
  const rest = await readStashStack(ctx);
  const newTop = rest[rest.length - 1]?.sha ?? null;
  if (newTop) {
    await git.writeRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'refs/stash', value: newTop, force: true });
    await logRef(ctx, 'refs/stash', entry.sha, newTop, `pop: ${entry.message}`);
  } else {
    await git.deleteRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'refs/stash' }).catch(() => undefined);
  }
  return ok(status + `\nDropped refs/stash@{0} (${entry.sha})\n`);
}

async function stashDrop(ctx: EngineContext): Promise<ExecOutput> {
  const entry = await popStash(ctx);
  if (!entry) return fail('No stash entries found.\n');
  const rest = await readStashStack(ctx);
  const newTop = rest[rest.length - 1]?.sha ?? null;
  if (newTop) {
    await git.writeRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'refs/stash', value: newTop, force: true });
  } else {
    await git.deleteRef({ fs: ctx.gitFs, dir: ctx.dir, ref: 'refs/stash' }).catch(() => undefined);
  }
  return ok(`Dropped stash@{0} (${entry.sha})\n`);
}
