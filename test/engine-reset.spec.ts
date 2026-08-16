// Phase 5: git reset --soft / --mixed / --hard against the real engine.
// Soft moves only the ref, mixed also resets the index, hard resets all
// three trees. Untracked files survive every mode.

import { describe, expect, it } from 'vitest';
import type { FileEntry, RepoSnapshot } from '@/core/types';
import { INITIAL_SETUP, makeEngine } from './engine.helpers';

const work = (snap: RepoSnapshot, path: string): FileEntry | undefined =>
  snap.workingTree.find((f) => f.path === path);
const staged = (snap: RepoSnapshot, path: string): FileEntry | undefined =>
  snap.index.find((f) => f.path === path);

/** initial commit (a.txt alpha, b.txt bravo) plus a second commit editing a.txt. */
async function twoCommitRepo() {
  const { engine, writeWorkdirFile } = await makeEngine();
  await engine.buildLevel(INITIAL_SETUP);
  await writeWorkdirFile('a.txt', 'alpha two\n');
  await engine.run('git add a.txt');
  await engine.run('git commit -m second');
  return { engine, writeWorkdirFile };
}

describe('git reset', () => {
  it('--soft moves only the ref; index and workdir are untouched', async () => {
    const { engine } = await twoCommitRepo();
    const r = await engine.run('git reset --soft HEAD~1');
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('');
    const snap = r.snapshot;
    expect(snap.commits[snap.branches.main]?.message).toContain('initial commit');
    expect(work(snap, 'a.txt')?.status).toBe('clean'); // workdir matches index
    expect(work(snap, 'a.txt')?.content).toBe('alpha two\n');
    expect(staged(snap, 'a.txt')?.status).toBe('staged'); // index ahead of HEAD
  });

  it('bare "git reset" is --mixed: index takes the target tree, workdir keeps its bytes', async () => {
    const { engine } = await twoCommitRepo();
    const r = await engine.run('git reset HEAD~1');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('Unstaged changes after reset:');
    expect(r.stdout).toContain('M\ta.txt');
    const snap = r.snapshot;
    expect(snap.commits[snap.branches.main]?.message).toContain('initial commit');
    expect(staged(snap, 'a.txt')?.status).toBe('clean');
    expect(work(snap, 'a.txt')?.status).toBe('modified');
    expect(work(snap, 'a.txt')?.content).toBe('alpha two\n');
  });

  it('--hard resets all three trees but keeps untracked files', async () => {
    const { engine, writeWorkdirFile } = await twoCommitRepo();
    await writeWorkdirFile('notes.txt', 'scratch\n');
    const r = await engine.run('git reset --hard HEAD~1');
    expect(r.ok).toBe(true);
    expect(r.stdout).toMatch(/^HEAD is now at [0-9a-f]{7} initial commit\n/);
    const snap = r.snapshot;
    expect(work(snap, 'a.txt')?.status).toBe('clean');
    expect(work(snap, 'a.txt')?.content).toBe('alpha\n');
    expect(staged(snap, 'a.txt')?.status).toBe('clean');
    expect(work(snap, 'notes.txt')?.status).toBe('untracked');
  });

  it('accepts branch names as the target', async () => {
    const { engine } = await twoCommitRepo();
    await engine.run('git branch keep');
    const back = await engine.run('git reset --hard HEAD~1');
    expect(back.snapshot.commits[back.snapshot.branches.main]?.message).toContain('initial');
    const fwd = await engine.run('git reset --hard keep');
    expect(fwd.ok).toBe(true);
    expect(fwd.snapshot.commits[fwd.snapshot.branches.main]?.message).toContain('second');
    expect(work(fwd.snapshot, 'a.txt')?.content).toBe('alpha two\n');
  });

  it('HEAD~n past the root fails with the real ambiguous-argument text', async () => {
    const { engine } = await twoCommitRepo();
    const r = await engine.run('git reset --hard HEAD~5');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("fatal: ambiguous argument 'HEAD~5'");
  });

  it('unknown revisions fail and point at restore --staged', async () => {
    const { engine } = await twoCommitRepo();
    const r = await engine.run('git reset --hard nowhere');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("fatal: ambiguous argument 'nowhere'");
    expect(r.stderr).toContain('git restore --staged');
  });

  it('refuses path resets with a teaching hint', async () => {
    const { engine } = await twoCommitRepo();
    const r = await engine.run('git reset HEAD a.txt');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('resetting paths is not supported');
    expect(r.stderr).toContain('git restore --staged');
  });

  it('--hard aborts a conflicted merge: markers and MERGE_HEAD are gone', async () => {
    const { engine, writeWorkdirFile } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    await engine.run('git branch feature');
    await writeWorkdirFile('a.txt', 'alpha main\n');
    await engine.run('git add a.txt');
    await engine.run('git commit -m main');
    await engine.run('git switch feature');
    await writeWorkdirFile('a.txt', 'alpha feature\n');
    await engine.run('git add a.txt');
    await engine.run('git commit -m feature');
    await engine.run('git switch main');

    const merge = await engine.run('git merge feature');
    expect(merge.ok).toBe(false);
    expect(merge.snapshot.workingTree.some((f) => f.status === 'conflicted')).toBe(true);

    const r = await engine.run('git reset --hard HEAD');
    expect(r.ok).toBe(true);
    expect(r.snapshot.workingTree.every((f) => f.status === 'clean')).toBe(true);
    expect(r.snapshot.index.every((f) => f.status === 'clean')).toBe(true);
    expect(work(r.snapshot, 'a.txt')?.content).toBe('alpha main\n');
  });
});
