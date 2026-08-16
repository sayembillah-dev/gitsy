import { describe, expect, it } from 'vitest';
import { predicateRegistry, reachableFrom, resolveRefish } from '@/core/predicates';
import type { RepoSnapshot } from '@/core/types';
import { chainGraph, file, makeCommit, makeSnap, mergeGraph } from './snap.helpers';

const run = (name: string, snap: RepoSnapshot, ...args: unknown[]): boolean => {
  const entry = predicateRegistry[name];
  expect(entry, `registry has ${name}`).toBeDefined();
  return entry.fn(snap, ...args);
};

function linearSnap() {
  const g = chainGraph();
  const snap = makeSnap({
    commits: g.commits,
    branches: { main: g.c3.hash, feature: g.c2.hash },
    tags: { v1: g.c1.hash },
    head: { type: 'branch', name: 'main' },
  });
  return { snap, ...g };
}

describe('predicate registry: ref and head predicates', () => {
  it('refExists: branch, tag, or remote-tracking ref by name', () => {
    const { snap } = linearSnap();
    expect(run('refExists', snap, 'main')).toBe(true);
    expect(run('refExists', snap, 'v1')).toBe(true);
    expect(run('refExists', snap, 'nope')).toBe(false);
    const withRemote = makeSnap({ ...snap, remoteBranches: { main: snap.branches.main } });
    expect(run('refExists', withRemote, 'main')).toBe(true);
  });

  it('headIsOn: HEAD points at the given branch', () => {
    const { snap, c2 } = linearSnap();
    expect(run('headIsOn', snap, 'main')).toBe(true);
    expect(run('headIsOn', snap, 'feature')).toBe(false);
    const detached = makeSnap({ ...snap, head: { type: 'detached', at: c2.hash } });
    expect(run('headIsOn', detached, 'main')).toBe(false);
  });

  it('detachedHead: HEAD directly at a commit', () => {
    const { snap, c2 } = linearSnap();
    expect(run('detachedHead', snap)).toBe(false);
    const detached = makeSnap({ ...snap, head: { type: 'detached', at: c2.hash } });
    expect(run('detachedHead', detached)).toBe(true);
  });
});

describe('predicate registry: history predicates', () => {
  it('commitCount: exact reachable count from a ref', () => {
    const { snap } = linearSnap();
    expect(run('commitCount', snap, 'main', 3)).toBe(true);
    expect(run('commitCount', snap, 'main', 2)).toBe(false);
    expect(run('commitCount', snap, 'feature', 2)).toBe(true);
    expect(run('commitCount', snap, 'HEAD', 3)).toBe(true);
    expect(run('commitCount', snap, 'gone', 0)).toBe(false);
  });

  it('commitReachable: exact message match on reachable commits', () => {
    const { snap } = linearSnap();
    expect(run('commitReachable', snap, 'HEAD', 'second')).toBe(true);
    expect(run('commitReachable', snap, 'feature', 'third')).toBe(false);
    expect(run('commitReachable', snap, 'HEAD', 'Second')).toBe(false);
    expect(run('commitReachable', snap, 'gone', 'root')).toBe(false);
  });

  it('isAncestor: git semantics, equality counts', () => {
    const { snap, c1, c3 } = linearSnap();
    expect(run('isAncestor', snap, c1.hash, c3.hash)).toBe(true);
    expect(run('isAncestor', snap, c3.hash, c1.hash)).toBe(false);
    expect(run('isAncestor', snap, c3.hash, c3.hash)).toBe(true);
    expect(run('isAncestor', snap, 'v1', 'main')).toBe(true);
  });

  it('noMergeCommits: rejects when a merge is reachable', () => {
    const { snap } = linearSnap();
    expect(run('noMergeCommits', snap, 'main')).toBe(true);
    const g = mergeGraph();
    const merged = makeSnap({ commits: g.commits, branches: { main: g.merge.hash } });
    expect(run('noMergeCommits', merged, 'main')).toBe(false);
    expect(run('noMergeCommits', merged, g.side.hash)).toBe(true);
  });

  it('isLinear: single straight chain with a single root', () => {
    const { snap } = linearSnap();
    expect(run('isLinear', snap, 'HEAD')).toBe(true);
    const g = mergeGraph();
    const merged = makeSnap({ commits: g.commits, branches: { main: g.merge.hash } });
    expect(run('isLinear', merged, 'main')).toBe(false);
    expect(run('isLinear', snap, 'gone')).toBe(false);
  });
});

describe('predicate registry: working tree and index predicates', () => {
  it('workingTreeClean: both panels clean, like "nothing to commit"', () => {
    expect(
      run(
        'workingTreeClean',
        makeSnap({
          workingTree: [file('a.txt', 'clean', 'a')],
          index: [file('a.txt', 'clean', 'a')],
        }),
      ),
    ).toBe(true);
    expect(
      run('workingTreeClean', makeSnap({ workingTree: [file('n.txt', 'untracked', 'n')] })),
    ).toBe(false);
    expect(
      run('workingTreeClean', makeSnap({ workingTree: [file('a.txt', 'modified', 'a2')] })),
    ).toBe(false);
    // Staged but uncommitted: workdir side reads clean, index side does not.
    expect(
      run(
        'workingTreeClean',
        makeSnap({
          workingTree: [file('a.txt', 'clean', 'a2')],
          index: [file('a.txt', 'staged', 'a2')],
        }),
      ),
    ).toBe(false);
    expect(
      run('workingTreeClean', makeSnap({ workingTree: [file('a.txt', 'deleted')] })),
    ).toBe(false);
  });

  it('fileStaged: index version differs from HEAD', () => {
    const snap = makeSnap({ index: [file('a.txt', 'staged', 'a2'), file('b.txt', 'clean', 'b')] });
    expect(run('fileStaged', snap, 'a.txt')).toBe(true);
    expect(run('fileStaged', snap, 'b.txt')).toBe(false);
    expect(run('fileStaged', snap, 'missing.txt')).toBe(false);
  });

  it('fileModified: workdir version differs from the index', () => {
    const snap = makeSnap({
      workingTree: [file('a.txt', 'modified', 'a2'), file('b.txt', 'clean', 'b')],
    });
    expect(run('fileModified', snap, 'a.txt')).toBe(true);
    expect(run('fileModified', snap, 'b.txt')).toBe(false);
    expect(run('fileModified', snap, 'missing.txt')).toBe(false);
  });

  it('hasConflict: any conflicted entry in either panel', () => {
    expect(
      run('hasConflict', makeSnap({ workingTree: [file('a.txt', 'conflicted', '<<<')] })),
    ).toBe(true);
    expect(run('hasConflict', makeSnap({ index: [file('a.txt', 'conflicted', '<<<')] }))).toBe(
      true,
    );
    expect(run('hasConflict', makeSnap({ workingTree: [file('a.txt', 'modified', 'x')] }))).toBe(
      false,
    );
  });

  it('stashCount: exact stash depth', () => {
    const { c1 } = chainGraph();
    const snap = makeSnap({ stash: [{ message: 'wip', hash: c1.hash }] });
    expect(run('stashCount', snap, 1)).toBe(true);
    expect(run('stashCount', snap, 0)).toBe(false);
    expect(run('stashCount', makeSnap(), 0)).toBe(true);
  });
});

describe('predicate registry: tags, remotes, reachability', () => {
  it('tagExists', () => {
    const { snap } = linearSnap();
    expect(run('tagExists', snap, 'v1')).toBe(true);
    expect(run('tagExists', snap, 'v2')).toBe(false);
  });

  it('maxCommands: reads the injected command count', () => {
    const snap = makeSnap();
    expect(run('maxCommands', snap, 5, 4)).toBe(true);
    expect(run('maxCommands', snap, 5, 5)).toBe(true);
    expect(run('maxCommands', snap, 5, 6)).toBe(false);
    expect(run('maxCommands', snap, 5)).toBe(false);
    expect(predicateRegistry.maxCommands.needsEnv).toBe(true);
  });

  it('remoteAhead: remote tip not reachable from local tip', () => {
    const g = chainGraph();
    const remoteOnly = makeCommit('teammate work', [g.c3.hash], { 'a.txt': 'four\n' });
    const remoteSnap = {
      commits: { ...g.commits, [remoteOnly.hash]: remoteOnly },
      branches: { main: remoteOnly.hash },
      tags: {},
      remoteBranches: {},
      head: { type: 'branch', name: 'main' } as const,
      workingTree: [],
      index: [],
      stash: [],
      reflog: [],
    };
    const behind = makeSnap({
      commits: g.commits,
      branches: { main: g.c3.hash },
      remote: remoteSnap,
    });
    expect(run('remoteAhead', behind, 'main')).toBe(true);
    const caughtUp = makeSnap({
      ...behind,
      commits: { ...g.commits, [remoteOnly.hash]: remoteOnly },
      branches: { main: remoteOnly.hash },
    });
    expect(run('remoteAhead', caughtUp, 'main')).toBe(false);
    expect(run('remoteAhead', makeSnap(), 'main')).toBe(false);
    expect(run('remoteAhead', behind, 'gone')).toBe(false);
  });

  it('trackingSet: remote-tracking ref exists locally', () => {
    const { snap, c3 } = linearSnap();
    expect(run('trackingSet', snap, 'main')).toBe(false);
    const tracked = makeSnap({ ...snap, remoteBranches: { main: c3.hash } });
    expect(run('trackingSet', tracked, 'main')).toBe(true);
    expect(run('trackingSet', tracked, 'dev')).toBe(false);
  });

  it('stillReachable: any ref, stash, or reflog entry keeps a commit alive', () => {
    const g = chainGraph();
    const orphan = makeCommit('lost work', [g.c1.hash], { 'a.txt': 'lost\n' });
    const commits = { ...g.commits, [orphan.hash]: orphan };
    const alive = makeSnap({ commits, branches: { main: g.c3.hash } });
    expect(run('stillReachable', alive, g.c2.hash)).toBe(true);
    expect(run('stillReachable', alive, orphan.hash)).toBe(false);
    const viaTag = makeSnap({ ...alive, tags: { rescue: orphan.hash } });
    expect(run('stillReachable', viaTag, orphan.hash)).toBe(true);
    const viaReflog = makeSnap({ ...alive, reflog: [{ hash: orphan.hash, label: 'commit' }] });
    expect(run('stillReachable', viaReflog, orphan.hash)).toBe(true);
    expect(run('stillReachable', alive, 'deadbeef')).toBe(false);
  });
});

describe('predicate registry: helpers', () => {
  it('resolveRefish accepts names, HEAD, and raw hashes', () => {
    const { snap, c1, c2 } = linearSnap();
    expect(resolveRefish(snap, 'main')).toBe(snap.branches.main);
    expect(resolveRefish(snap, 'v1')).toBe(c1.hash);
    expect(resolveRefish(snap, 'HEAD')).toBe(snap.branches.main);
    expect(resolveRefish(snap, c1.hash)).toBe(c1.hash);
    expect(resolveRefish(snap, 'gone')).toBeNull();
    const detached = makeSnap({ ...snap, head: { type: 'detached', at: c2.hash } });
    expect(resolveRefish(detached, 'HEAD')).toBe(c2.hash);
  });

  it('reachableFrom walks parents and tolerates dangling nodes', () => {
    const { snap, c1, c3 } = linearSnap();
    const set = reachableFrom(snap, c3.hash);
    expect(set.size).toBe(3);
    expect(set.has(c1.hash)).toBe(true);
    const dangling = makeSnap({
      commits: snap.commits,
      branches: {},
      head: { type: 'branch', name: 'main' },
    });
    expect(reachableFrom(dangling, c1.hash).has(c1.hash)).toBe(true);
  });
});
