// Phase 1 gate (BUILD-PLAN section 5): run buildLevel then a command
// sequence, assert on the returned RepoSnapshot. Same setup twice must yield
// identical structural hashes.

import { describe, expect, it } from 'vitest';
import { INITIAL_SETUP, makeEngine } from './engine.helpers';

describe('determinism (section 3 rule)', () => {
  it('same setup run twice yields identical snapshots, structural hashes and git SHAs alike', async () => {
    const [x, y] = await Promise.all([makeEngine(), makeEngine()]);
    const s1 = await x.engine.buildLevel(INITIAL_SETUP);
    const s2 = await y.engine.buildLevel(INITIAL_SETUP);
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
  });
});

describe('Act 1 session', () => {
  it('runs status, add, commit, log, diff, restore end to end', async () => {
    const { engine, writeWorkdirFile } = await makeEngine();
    const snap0 = await engine.buildLevel(INITIAL_SETUP);
    expect(snap0.head).toEqual({ type: 'branch', name: 'main' });
    expect(Object.keys(snap0.commits)).toHaveLength(1);
    expect(snap0.workingTree.every((f) => f.status === 'clean')).toBe(true);

    // modify a file: status reports it, the worktree entry flips to modified
    await writeWorkdirFile('a.txt', 'alpha v2\n');
    const r1 = await engine.run('git status');
    expect(r1.ok).toBe(true);
    expect(r1.stdout).toContain('On branch main');
    expect(r1.stdout).toContain('modified:   a.txt');
    expect(r1.snapshot.workingTree.find((f) => f.path === 'a.txt')?.status).toBe('modified');

    // stage it: index entry flips to staged, worktree back to clean (workdir == index)
    const r2 = await engine.run('git add a.txt');
    expect(r2.ok).toBe(true);
    expect(r2.snapshot.index.find((f) => f.path === 'a.txt')?.status).toBe('staged');
    expect(r2.snapshot.workingTree.find((f) => f.path === 'a.txt')?.status).toBe('clean');

    // diff --cached shows the staged change
    const r3 = await engine.run('git diff --cached');
    expect(r3.ok).toBe(true);
    expect(r3.stdout).toContain('diff --git a/a.txt b/a.txt');
    expect(r3.stdout).toContain('+alpha v2');

    // commit moves main and links the new commit to its parent
    const r4 = await engine.run('git commit -m "update alpha"');
    expect(r4.ok).toBe(true);
    expect(r4.stdout).toContain('[main ');
    expect(r4.stdout).toContain('update alpha');
    const snap4 = r4.snapshot;
    expect(Object.keys(snap4.commits)).toHaveLength(2);
    const tip = snap4.branches.main;
    expect(snap4.commits[tip].message).toBe('update alpha');
    const parent = snap4.commits[tip].parents[0];
    expect(snap4.commits[parent].message).toBe('initial commit');
    expect(snap4.workingTree.every((f) => f.status === 'clean')).toBe(true);

    // log --oneline shows newest first
    const r5 = await engine.run('git log --oneline');
    const lines = r5.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('update alpha');
    expect(lines[1]).toContain('initial commit');

    // dirty the file again, see the unstaged diff, then restore it
    await writeWorkdirFile('a.txt', 'alpha v3\n');
    const r6 = await engine.run('git diff');
    expect(r6.stdout).toContain('+alpha v3');
    const r7 = await engine.run('git restore a.txt');
    expect(r7.ok).toBe(true);
    expect(r7.snapshot.workingTree.find((f) => f.path === 'a.txt')?.status).toBe('clean');

    // stage, then unstage with restore --staged
    await writeWorkdirFile('a.txt', 'alpha v4\n');
    await engine.run('git add a.txt');
    const r8 = await engine.run('git restore --staged a.txt');
    expect(r8.ok).toBe(true);
    expect(r8.snapshot.index.find((f) => f.path === 'a.txt')?.status).toBe('clean');
    expect(r8.snapshot.workingTree.find((f) => f.path === 'a.txt')?.status).toBe('modified');
  });

  it('tracks untracked files through add . and commit', async () => {
    const { engine, writeWorkdirFile } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    await writeWorkdirFile('new.txt', 'fresh\n');

    const r1 = await engine.run('git status');
    expect(r1.stdout).toContain('Untracked files');
    expect(r1.stdout).toContain('new.txt');
    expect(r1.snapshot.workingTree.find((f) => f.path === 'new.txt')?.status).toBe('untracked');

    await engine.run('git add .');
    const r2 = await engine.run('git commit -m "add new file"');
    expect(r2.ok).toBe(true);
    expect(r2.stdout).toContain('1 file changed');
    expect(r2.snapshot.workingTree.find((f) => f.path === 'new.txt')?.status).toBe('clean');
  });

  it('supports git status -s XY codes', async () => {
    const { engine, writeWorkdirFile } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    await writeWorkdirFile('a.txt', 'changed\n');
    await writeWorkdirFile('u.txt', 'new\n');
    const r = await engine.run('git status -s');
    expect(r.stdout).toContain(' M a.txt');
    expect(r.stdout).toContain('?? u.txt');

    await engine.run('git add a.txt');
    const r2 = await engine.run('git status -s');
    expect(r2.stdout).toContain('M  a.txt');
  });

  it('reinitializes an existing repo', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const r = await engine.run('git init');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('Reinitialized existing Git repository');
  });
});

describe('real-shaped failures', () => {
  it('refuses a commit without -m', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const r = await engine.run('git commit');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('git commit -m');
  });

  it('refuses empty commits like real git', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const r = await engine.run('git commit -m "nothing"');
    expect(r.ok).toBe(false);
    expect(r.stdout).toContain('nothing to commit');
  });

  it('rejects unknown pathspecs', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const add = await engine.run('git add nope.txt');
    expect(add.ok).toBe(false);
    expect(add.stderr).toContain("pathspec 'nope.txt' did not match any files");
    const restore = await engine.run('git restore ghost.txt');
    expect(restore.ok).toBe(false);
    expect(restore.stderr).toContain("pathspec 'ghost.txt' did not match");
  });

  it('rejects unknown commands', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const r = await engine.run('git frobnicate');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("git: 'frobnicate' is not a git command");
  });

  it('keeps later-act commands locked', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const r = await engine.run('git rebase -i main');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('rebase: not available yet');
  });

  it('reports an unborn branch on log', async () => {
    const { engine } = await makeEngine();
    await engine.run('git init');
    const r = await engine.run('git log');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("branch 'main' does not have any commits yet");
  });
});

describe('stat-cache hazards', () => {
  // isomorphic-git's statusMatrix trusts stat data: a same-size rewrite inside
  // one mtime second reads as clean. Players hit that constantly, so Gitsy
  // compares content hashes across the three trees instead. Regression test:
  it('detects a same-size rewrite immediately', async () => {
    const { engine, writeWorkdirFile } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP); // a.txt is 'alpha\n', 6 bytes
    await writeWorkdirFile('a.txt', 'ALPHA\n'); // same 6 bytes, same second
    const r = await engine.run('git status -s');
    expect(r.stdout).toContain(' M a.txt');
    const d = await engine.run('git diff');
    expect(d.stdout).toContain('+ALPHA');
  });
});
