import { describe, expect, it } from 'vitest';
import { normalizeRepo, structHashOf, type RawRepo } from '@/core/normalize';

const base: RawRepo = {
  commits: [
    { sha: 'aaa111', message: 'initial\n', parents: [], tree: { 'a.txt': 'one\n' } },
    { sha: 'bbb222', message: 'second\n', parents: ['aaa111'], tree: { 'a.txt': 'two\n' } },
  ],
  branches: { main: 'bbb222' },
  tags: { v1: 'aaa111' },
  remoteBranches: {},
  head: { type: 'branch', name: 'main' },
  workingTree: [{ path: 'a.txt', status: 'clean', content: 'two\n' }],
  index: [{ path: 'a.txt', status: 'clean', content: 'two\n' }],
  stash: [],
  reflog: [],
  worktrees: [],
};

const parentHash = structHashOf('initial', [], { 'a.txt': 'one\n' });
const childHash = structHashOf('second', [parentHash], { 'a.txt': 'two\n' });

describe('normalizeRepo', () => {
  it('links parents by structural hash and maps refs', () => {
    const snap = normalizeRepo(base);
    expect(snap.branches.main).toBe(childHash);
    expect(snap.tags.v1).toBe(parentHash);
    expect(snap.commits[childHash].parents).toEqual([parentHash]);
    expect(snap.head).toEqual({ type: 'branch', name: 'main' });
  });

  it('strips trailing newlines from messages before hashing and display', () => {
    const snap = normalizeRepo(base);
    expect(snap.commits[parentHash].message).toBe('initial');
    expect(snap.branches.main).toBe(childHash);
  });

  it('is deterministic for identical input', () => {
    expect(JSON.stringify(normalizeRepo(base))).toBe(JSON.stringify(normalizeRepo(base)));
  });

  it('ignores git SHAs: same content with different sha gives the same structural hash', () => {
    const a = normalizeRepo({
      ...base,
      commits: [base.commits[0]],
      branches: { main: 'aaa111' },
      tags: {},
    });
    const b = normalizeRepo({
      ...base,
      commits: [{ sha: 'zzz999', message: 'initial', parents: [], tree: { 'a.txt': 'one\n' } }],
      branches: { main: 'zzz999' },
      tags: {},
    });
    expect(a.branches.main).toBe(b.branches.main);
    expect(a.branches.main).not.toBe('aaa111');
  });

  it('maps detached HEAD to a structural hash', () => {
    const snap = normalizeRepo({ ...base, head: { type: 'detached', sha: 'aaa111' } });
    expect(snap.head).toEqual({ type: 'detached', at: parentHash });
  });

  it('maps journal-backed stash and reflog entries to structural hashes', () => {
    const snap = normalizeRepo({
      ...base,
      stash: [{ sha: 'aaa111', message: 'WIP on main' }],
      reflog: [{ sha: 'bbb222', label: 'commit: second' }],
      worktrees: [{ path: 'wt-dir', branch: 'hotfix' }],
    });
    expect(snap.stash).toEqual([{ message: 'WIP on main', hash: parentHash }]);
    expect(snap.reflog).toEqual([{ hash: childHash, label: 'commit: second' }]);
    expect(snap.worktrees).toEqual([{ path: 'wt-dir', branch: 'hotfix' }]);
  });

  it('skips journal entries whose commit is not in the walk', () => {
    const snap = normalizeRepo({
      ...base,
      stash: [{ sha: 'zzz999', message: 'ghost' }],
      reflog: [{ sha: 'zzz999', label: 'ghost' }],
    });
    expect(snap.stash).toEqual([]);
    expect(snap.reflog).toEqual([]);
  });

  it('throws a descriptive error when a parent object is missing', () => {
    const broken: RawRepo = {
      ...base,
      commits: [{ sha: 'bbb222', message: 'second', parents: ['missing'], tree: {} }],
      branches: { main: 'bbb222' },
      tags: {},
    };
    expect(() => normalizeRepo(broken)).toThrow(/missing commit object/);
  });
});
