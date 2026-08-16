// Phase 10 gate, Act 4: amend, revert, cherry-pick, rebase (plain and -i),
// stash, and the dirty-tree switch refusal that makes stash necessary.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameCommit, SetupOp, StructHash } from '@/core/types';
import { makeEngine } from './engine.helpers';

const BASE: SetupOp[] = [
  { op: 'commit', message: 'add app v1', files: { 'app.txt': 'app v1\n' } },
];

const FEATURE_SETUP: SetupOp[] = [
  { op: 'commit', message: 'initial commit', files: { 'app.txt': 'app v1\n' } },
  { op: 'branch', name: 'feature' },
  { op: 'checkout', ref: 'feature' },
  { op: 'commit', message: 'feature work', files: { 'feature.txt': 'feature\n' } },
  { op: 'checkout', ref: 'main' },
  { op: 'commit', message: 'main moves on', files: { 'app.txt': 'app v2\n' } },
];

describe('commit --amend', () => {
  it('rewrites the tip message and reports the rewrite map', async () => {
    const { engine } = await makeEngine();
    const before = await engine.buildLevel(BASE);
    const oldHash = before.branches.main;
    const r = await engine.run('git commit --amend -m "add app v1 (final)"');
    expect(r.ok).toBe(true);
    expect(r.snapshot.branches.main).not.toBe(oldHash);
    const tip = r.snapshot.commits[r.snapshot.branches.main];
    expect(tip.message).toBe('add app v1 (final)');
    // Two commits in the object store: the rewrite and the abandoned
    // original (the reflog walk keeps ghosts drawable).
    expect(Object.keys(r.snapshot.commits)).toHaveLength(2);
    expect(r.snapshot.commits[oldHash]?.message).toBe('add app v1');
    // The rewrite map morphs old to new; the original stays in the reflog.
    expect(r.rewrites?.[oldHash]).toBe(r.snapshot.branches.main);
    expect(r.snapshot.reflog.some((e) => e.hash === oldHash)).toBe(true);
  });

  it('folds staged changes into the amended commit', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(BASE);
    await engine.editFile('config.txt', 'debug = false\n');
    await engine.run('git add config.txt');
    const r = await engine.run('git commit --amend -m "add app v1 with config"');
    expect(r.ok).toBe(true);
    expect(r.snapshot.commits[r.snapshot.branches.main].tree['config.txt']).toBe('debug = false\n');
    expect(r.snapshot.commits[r.snapshot.branches.main].tree['app.txt']).toBe('app v1\n');
  });

  it('refuses to amend with no commits', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([]);
    const r = await engine.run('git commit --amend -m nope');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('nothing to amend');
  });
});

describe('git revert', () => {
  const SETUP: SetupOp[] = [
    { op: 'commit', message: 'add app v1', files: { 'app.txt': 'app v1\n' } },
    { op: 'commit', message: 'add telemetry', files: { 'app.txt': 'app v1\ntelemetry: on\n' } },
    { op: 'commit', message: 'add docs', files: { 'README.md': '# app\n' } },
  ];

  it('reverts HEAD~1 cleanly: the anti-commit lands on top', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    const r = await engine.run('git revert HEAD~1');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('Revert "add telemetry"');
    const tip = r.snapshot.commits[r.snapshot.branches.main];
    expect(tip.message).toBe('Revert "add telemetry"');
    expect(tip.tree['app.txt']).toBe('app v1\n');
    expect(tip.tree['README.md']).toBe('# app\n');
  });

  it('keeps the original commit reachable (history is append-only)', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    const r = await engine.run('git revert HEAD~1');
    const messages = Object.values(r.snapshot.commits).map((c) => c.message);
    expect(messages).toContain('add telemetry');
  });

  it('errors on unknown revs and merge commits', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    const bad = await engine.run('git revert nosuchref');
    expect(bad.ok).toBe(false);
    expect(bad.stderr).toContain('unknown revision');
  });
});

describe('git cherry-pick', () => {
  const SETUP: SetupOp[] = [
    { op: 'commit', message: 'add app v1', files: { 'app.txt': 'app v1\n' } },
    { op: 'branch', name: 'fix' },
    { op: 'checkout', ref: 'fix' },
    { op: 'commit', message: 'fix the crash', files: { 'app.txt': 'app v1\ncrash fix\n' } },
    { op: 'commit', message: 'debug logging', files: { 'debug.txt': 'debug\n' } },
    { op: 'checkout', ref: 'main' },
  ];

  it('copies exactly one commit onto main (fix~1)', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    const r = await engine.run('git cherry-pick fix~1');
    expect(r.ok).toBe(true);
    const tip = r.snapshot.commits[r.snapshot.branches.main];
    expect(tip.message).toBe('fix the crash');
    expect(tip.tree['app.txt']).toBe('app v1\ncrash fix\n');
    expect(tip.tree['debug.txt']).toBeUndefined();
    // The branch is untouched: fix still has its own two commits.
    expect(r.snapshot.commits[r.snapshot.branches.fix].message).toBe('debug logging');
  });

  it('stops on conflict and git commit finishes with the original message', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([
      { op: 'commit', message: 'base', files: { 'app.txt': 'v1\n' } },
      { op: 'branch', name: 'fix' },
      { op: 'checkout', ref: 'fix' },
      { op: 'commit', message: 'fix it', files: { 'app.txt': 'v1 fixed\n' } },
      { op: 'checkout', ref: 'main' },
      { op: 'commit', message: 'conflicting work', files: { 'app.txt': 'v1 otherwise\n' } },
    ]);
    const r = await engine.run('git cherry-pick fix');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('could not apply');
    expect(r.snapshot.workingTree.some((f) => f.status === 'conflicted')).toBe(true);

    await engine.editFile('app.txt', 'v1 fixed\n');
    await engine.run('git add app.txt');
    const done = await engine.run('git commit -m "unused default"');
    expect(done.ok).toBe(true);
    // CHERRY_PICK_MSG wins when no -m is given; here -m was given.
    expect(done.snapshot.commits[done.snapshot.branches.main].message).toBe('unused default');
    expect(done.snapshot.workingTree.every((f) => f.status === 'clean')).toBe(true);
  });
});

describe('git rebase', () => {
  it('GATE: replays feature onto main; the old commit stays as a ghost', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(FEATURE_SETUP);
    await engine.run('git switch feature');
    const before = await engine.snapshot();
    const oldTip = before.branches.feature;

    const r = await engine.run('git rebase main');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('Successfully rebased and updated refs/heads/feature.');

    const s = r.snapshot;
    expect(s.head).toEqual({ type: 'branch', name: 'feature' });
    // main is now an ancestor of feature (linearized).
    const featureTip = s.commits[s.branches.feature];
    expect(featureTip.message).toBe('feature work');
    expect(featureTip.parents).toHaveLength(1);
    expect(featureTip.parents[0]).toBe(s.branches.main);
    // The rewrite map morphs old to new; the original remains, abandoned.
    expect(r.rewrites?.[oldTip]).toBe(s.branches.feature);
    expect(s.commits[oldTip]).toBeDefined();
    expect(s.commits[oldTip].message).toBe('feature work');
    expect(s.reflog.some((e) => e.hash === oldTip)).toBe(true);
  });

  it('answers up-to-date and fast-forward cases like real git', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([
      { op: 'commit', message: 'base', files: { 'a.txt': 'a\n' } },
      { op: 'branch', name: 'feature' },
      { op: 'commit', message: 'main work', files: { 'b.txt': 'b\n' } },
    ]);
    const up = await engine.run('git rebase main'); // main rebased on itself
    expect(up.ok).toBe(true);
    expect(up.stdout).toContain('up to date');

    const ff = await engine.run('git rebase main feature'); // feature behind main
    expect(ff.ok).toBe(true);
    expect(ff.stdout).toContain('Successfully rebased');
    expect(ff.snapshot.branches.feature).toBe(ff.snapshot.branches.main);
  });

  it('refuses with a dirty tracked tree', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(FEATURE_SETUP);
    await engine.editFile('app.txt', 'dirty\n');
    const r = await engine.run('git rebase feature');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('cannot rebase');
  });
});

describe('git rebase -i', () => {
  const SETUP: SetupOp[] = [
    { op: 'commit', message: 'base commit', files: { 'app.txt': 'app\n' } },
    { op: 'branch', name: 'feature' },
    { op: 'checkout', ref: 'feature' },
    { op: 'commit', message: 'add parser', files: { 'parser.txt': 'parser v1\n' } },
    { op: 'commit', message: 'WIP', files: { 'parser.txt': 'parser v1\nwip\n' } },
    { op: 'commit', message: 'debug junk', files: { 'debug.txt': 'junk\n' } },
    { op: 'commit', message: 'add tests', files: { 'tests.txt': 'tests\n' } },
  ];

  const startTodo = async (engine: Awaited<ReturnType<typeof makeEngine>>['engine'], dir: string) => {
    await engine.buildLevel(SETUP);
    const r = await engine.run('git rebase -i main');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('REBASE_TODO');
    return readFile(join(dir, 'REBASE_TODO'), 'utf8');
  };

  it('drops and squashes via the todo worksheet', async () => {
    const { engine, dir } = await makeEngine();
    const todo = await startTodo(engine, dir);
    const lines = todo.split('\n').filter((l) => l.startsWith('pick '));
    expect(lines).toHaveLength(4);

    const edited =
      lines[0] + '\n' +
      lines[1].replace(/^pick/, 'squash') + '\n' +
      lines[2].replace(/^pick/, 'drop') + '\n' +
      lines[3] + '\n';
    const edit = await engine.editFile('REBASE_TODO', edited);
    expect(edit.ok).toBe(true);

    const r = await engine.run('git rebase --continue');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('Successfully rebased');

    const s = r.snapshot;
    expect(s.head).toEqual({ type: 'branch', name: 'feature' });
    const tip = s.commits[s.branches.feature];
    expect(tip.message).toBe('add tests');
    const squashed = s.commits[tip.parents[0]];
    expect(squashed.message).toBe('add parser\n\nWIP');
    expect(squashed.tree['parser.txt']).toBe('parser v1\nwip\n');
    expect(squashed.tree['debug.txt']).toBeUndefined();
    expect(tip.tree['debug.txt']).toBeUndefined();
    expect(s.commits[squashed.parents[0]].message).toBe('base commit');
    // The worksheet is gone once the rebase finishes.
    expect(s.workingTree.some((f) => f.path === 'REBASE_TODO')).toBe(false);
  });

  it('reword renames inline; todo parse errors stay in todo mode', async () => {
    const { engine, dir } = await makeEngine();
    const todo = await startTodo(engine, dir);
    const lines = todo.split('\n').filter((l) => l.startsWith('pick '));

    // Unknown SHA: rejected, still waiting on the worksheet.
    const badEdit = 'pick deadbeef nope\n';
    await engine.editFile('REBASE_TODO', badEdit);
    const bad = await engine.run('git rebase --continue');
    expect(bad.ok).toBe(false);
    expect(bad.stderr).toContain('outside this rebase');

    // squash on the first kept line: rejected.
    await engine.editFile(
      'REBASE_TODO',
      lines.map((l) => l.replace(/^pick/, 'squash')).join('\n') + '\n',
    );
    const squashFirst = await engine.run('git rebase --continue');
    expect(squashFirst.ok).toBe(false);
    expect(squashFirst.stderr).toContain("cannot 'squash' without a previous commit");

    const good =
      `reword ${lines[0].split(' ')[1]} add the parser\n` +
      lines.slice(1).join('\n') + '\n';
    await engine.editFile('REBASE_TODO', good);
    const r = await engine.run('git rebase --continue');
    expect(r.ok).toBe(true);
    // Walk the live feature chain (ghosts from the rewrite stay in the map).
    const chainMessages: string[] = [];
    let cur: StructHash | undefined = r.snapshot.branches.feature;
    while (cur) {
      const c: GameCommit | undefined = r.snapshot.commits[cur];
      if (!c) break;
      chainMessages.push(c.message);
      cur = c.parents[0];
    }
    expect(chainMessages).toContain('add the parser');
    expect(chainMessages).not.toContain('add parser');
    expect(chainMessages).toContain('add tests');
  });

  it('git add refuses to stage the worksheet, and add . skips it', async () => {
    const { engine, dir } = await makeEngine();
    await startTodo(engine, dir);
    const explicit = await engine.run('git add REBASE_TODO');
    expect(explicit.ok).toBe(false);
    expect(explicit.stderr).toContain('worksheet');

    await engine.editFile('scratch.txt', 'scratch\n');
    const all = await engine.run('git add .');
    expect(all.ok).toBe(true);
    expect(
      all.snapshot.index.some((f) => f.path === 'REBASE_TODO' && f.status === 'staged'),
    ).toBe(false);
    expect(all.snapshot.index.some((f) => f.path === 'scratch.txt' && f.status === 'staged')).toBe(
      true,
    );
  });

  it('abort restores the original tip and deletes the worksheet', async () => {
    const { engine, dir } = await makeEngine();
    await startTodo(engine, dir);
    const before = await engine.snapshot();
    const r = await engine.run('git rebase --abort');
    expect(r.ok).toBe(true);
    expect(r.snapshot.branches.feature).toBe(before.branches.feature);
    expect(r.snapshot.workingTree.some((f) => f.path === 'REBASE_TODO')).toBe(false);
  });

  it('stops at a conflict; resolving and --continue finishes the rebase', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([
      { op: 'commit', message: 'base', files: { 'app.txt': 'v1\n' } },
      { op: 'branch', name: 'feature' },
      { op: 'checkout', ref: 'feature' },
      { op: 'commit', message: 'feature change', files: { 'app.txt': 'v1 feature\n' } },
      { op: 'checkout', ref: 'main' },
      { op: 'commit', message: 'main change', files: { 'app.txt': 'v1 main\n' } },
    ]);
    await engine.run('git switch feature');
    const r = await engine.run('git rebase main');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('could not apply');
    expect(r.snapshot.workingTree.some((f) => f.status === 'conflicted')).toBe(true);

    // Unresolved markers block --continue.
    const early = await engine.run('git rebase --continue');
    expect(early.ok).toBe(false);
    expect(early.stderr).toContain('unmerged files');

    await engine.editFile('app.txt', 'v1 main\nv1 feature\n');
    await engine.run('git add app.txt');
    const done = await engine.run('git rebase --continue');
    expect(done.ok).toBe(true);
    expect(done.stdout).toContain('Successfully rebased');
    const tip = done.snapshot.commits[done.snapshot.branches.feature];
    expect(tip.message).toBe('feature change');
    expect(tip.tree['app.txt']).toBe('v1 main\nv1 feature\n');
  });
});

describe('git stash', () => {
  const SETUP: SetupOp[] = [
    { op: 'commit', message: 'app v1', files: { 'app.txt': 'app v1\n' } },
    { op: 'branch', name: 'feature' },
    { op: 'checkout', ref: 'feature' },
    { op: 'commit', message: 'feature sketch', files: { 'app.txt': 'app v1\nfeature sketch\n' } },
    { op: 'checkout', ref: 'main' },
    { op: 'write', path: 'app.txt', content: 'app v1\nhalf-done\n' },
  ];

  it('push cleans the tree; pop restores the work unstaged', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);

    const dirtySwitch = await engine.run('git switch feature');
    expect(dirtySwitch.ok).toBe(false);
    expect(dirtySwitch.stderr).toContain('Your local changes');

    const stashed = await engine.run('git stash');
    expect(stashed.ok).toBe(true);
    expect(stashed.stdout).toContain('Saved working directory and index state WIP on main');
    expect(stashed.snapshot.stash).toHaveLength(1);
    expect(stashed.snapshot.workingTree.every((f) => f.status === 'clean')).toBe(true);

    expect((await engine.run('git switch feature')).ok).toBe(true);
    expect((await engine.run('git switch main')).ok).toBe(true);

    const popped = await engine.run('git stash pop');
    expect(popped.ok).toBe(true);
    expect(popped.stdout).toContain('Dropped refs/stash@{0}');
    expect(popped.snapshot.stash).toHaveLength(0);
    const app = popped.snapshot.workingTree.find((f) => f.path === 'app.txt');
    expect(app?.content).toBe('app v1\nhalf-done\n');
    expect(app?.status).toBe('modified');
  });

  it('stash list shows the stack newest-first; custom -m message', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    await engine.run('git stash push -m "hold the experiment"');
    const r = await engine.run('git stash list');
    expect(r.stdout).toContain('stash@{0}: hold the experiment');
  });

  it('answers "No local changes to save" on a clean tree', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(BASE);
    const r = await engine.run('git stash');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('No local changes to save');
  });

  it('pop on an empty stash fails like real git', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(BASE);
    const r = await engine.run('git stash pop');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('No stash entries found');
  });
});

describe('dirty-tree switch refusal (the stash setup)', () => {
  it('allows switching when the dirty files do not overlap the delta', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([
      { op: 'commit', message: 'base', files: { 'app.txt': 'v1\n', 'shared.txt': 'same\n' } },
      { op: 'branch', name: 'feature' },
      { op: 'checkout', ref: 'feature' },
      { op: 'commit', message: 'feature work', files: { 'app.txt': 'v2\n', 'shared.txt': 'same\n' } },
      { op: 'checkout', ref: 'main' },
      { op: 'write', path: 'notes.txt', content: 'untracked notes\n' },
    ]);
    // notes.txt is untracked and untouched by the delta: switch is fine.
    const r = await engine.run('git switch feature');
    expect(r.ok).toBe(true);
  });
});
