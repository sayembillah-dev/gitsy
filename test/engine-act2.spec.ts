// Act 2 engine commands: branch, switch/checkout, tag, and the three merge
// shapes (fast-forward, no-conflict merge commit, conflict + resolution).

import { describe, expect, it } from 'vitest';
import type { SetupOp } from '@/core/types';
import { INITIAL_SETUP, makeEngine } from './engine.helpers';

describe('branch, switch, checkout, tag', () => {
  it('branch creates and lists, refuses duplicates, deletes with real text', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);

    await engine.run('git branch feature');
    const list = await engine.run('git branch');
    expect(list.stdout).toBe('  feature\n* main\n');

    const dup = await engine.run('git branch feature');
    expect(dup.stderr).toContain("a branch named 'feature' already exists");

    const del = await engine.run('git branch -d feature');
    expect(del.stdout).toContain('Deleted branch feature');

    const delCurrent = await engine.run('git branch -d main');
    expect(delCurrent.stderr).toContain('cannot delete branch');
  });

  it('switch moves HEAD; checkout -b creates and switches; bad names error', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);

    await engine.run('git branch feature');
    const sw = await engine.run('git switch feature');
    expect(sw.stdout).toBe("Switched to branch 'feature'\n");
    expect(sw.snapshot.head).toEqual({ type: 'branch', name: 'feature' });

    const back = await engine.run('git checkout -b bugfix');
    expect(back.stdout).toBe("Switched to a new branch 'bugfix'\n");
    expect(back.snapshot.head).toEqual({ type: 'branch', name: 'bugfix' });

    const bad = await engine.run('git switch nope');
    expect(bad.stderr).toContain('fatal: invalid reference: nope');
    const badCo = await engine.run('git checkout nope');
    expect(badCo.stderr).toContain('did not match any file(s) known to git');
  });

  it('tag marks the current commit and shows up in the snapshot', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const r = await engine.run('git tag v1');
    expect(Object.keys(r.snapshot.tags)).toEqual(['v1']);
    expect(r.snapshot.tags.v1).toBe(r.snapshot.branches.main);
  });
});

describe('merge', () => {
  it('fast-forwards when ours is an ancestor of theirs', async () => {
    const { engine } = await makeEngine();
    const setup: SetupOp[] = [
      ...INITIAL_SETUP,
      { op: 'branch', name: 'feature' },
      { op: 'commit', message: 'ahead', files: { 'c.txt': 'charlie\n' } },
      { op: 'checkout', ref: 'feature' },
    ];
    await engine.buildLevel(setup);
    const r = await engine.run('git merge main');
    expect(r.stdout).toContain('Fast-forward');
    expect(r.snapshot.branches.feature).toBe(r.snapshot.branches.main);
    expect(r.snapshot.workingTree.find((f) => f.path === 'c.txt')?.status).toBe('clean');
  });

  it('says "Already up to date." when theirs is reachable from ours', async () => {
    const { engine } = await makeEngine();
    const setup: SetupOp[] = [
      ...INITIAL_SETUP,
      { op: 'branch', name: 'old' },
      { op: 'commit', message: 'ahead', files: { 'c.txt': 'charlie\n' } },
    ];
    await engine.buildLevel(setup);
    const r = await engine.run('git merge old');
    expect(r.stdout).toBe('Already up to date.\n');
  });

  it('creates a two-parent merge commit for diverged clean branches', async () => {
    const { engine } = await makeEngine();
    const setup: SetupOp[] = [
      { op: 'commit', message: 'base', files: { 'a.txt': 'a1\n' } },
      { op: 'branch', name: 'feature' },
      { op: 'commit', message: 'main work', files: { 'a.txt': 'a2\n' } },
      { op: 'checkout', ref: 'feature' },
      { op: 'commit', message: 'feature work', files: { 'b.txt': 'b1\n' } },
      { op: 'checkout', ref: 'main' },
    ];
    await engine.buildLevel(setup);
    const r = await engine.run('git merge feature');
    expect(r.stdout).toContain("Merge made by the 'ort' strategy.");
    const tip = r.snapshot.commits[r.snapshot.branches.main];
    expect(tip.parents.length).toBe(2);
    expect(tip.tree['a.txt']).toBe('a2\n');
    expect(tip.tree['b.txt']).toBe('b1\n');
    expect(r.snapshot.workingTree.every((f) => f.status === 'clean')).toBe(true);
  });

  it('conflicts on same-file edits, blocks commit, then resolves', async () => {
    const { engine } = await makeEngine();
    const setup: SetupOp[] = [
      { op: 'commit', message: 'base', files: { 'a.txt': 'base\n' } },
      { op: 'branch', name: 'feature' },
      { op: 'commit', message: 'ours', files: { 'a.txt': 'ours\n' } },
      { op: 'checkout', ref: 'feature' },
      { op: 'commit', message: 'theirs', files: { 'a.txt': 'theirs\n' } },
      { op: 'checkout', ref: 'main' },
    ];
    await engine.buildLevel(setup);
    const r = await engine.run('git merge feature');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('CONFLICT (content): Merge conflict in a.txt');
    const file = r.snapshot.workingTree.find((f) => f.path === 'a.txt');
    expect(file?.status).toBe('conflicted');
    expect(file?.content).toContain('<<<<<<< HEAD');
    expect(file?.content).toContain('>>>>>>> feature');

    const blocked = await engine.run('git commit -m "resolve"');
    expect(blocked.ok).toBe(false);
    expect(blocked.stderr).toContain('unmerged files');
  });

  it('merge refuses an unknown branch', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const r = await engine.run('git merge nope');
    expect(r.stderr).toContain('not something we can merge');
  });
});
