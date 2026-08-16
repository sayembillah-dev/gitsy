// Phase 9 gate: the remote simulation. origin is a second repo directory on
// the same fs; fetch/push run directly between the two, no HTTP transport.
// The gate level: origin/main visibly moves on fetch while main stays put.

import { describe, expect, it } from 'vitest';
import { predicateRegistry } from '@/core/predicates';
import type { RepoSnapshot, SetupOp } from '@/core/types';
import { INITIAL_SETUP, makeEngine } from './engine.helpers';

const pred = (name: string, snap: RepoSnapshot, ...args: unknown[]): boolean =>
  predicateRegistry[name].fn(snap, ...args);

/** The "you cloned this" state: one commit, pushed; tracking ref synced. */
const CLONED: SetupOp[] = [
  { op: 'commit', message: 'initial commit', files: { 'app.txt': 'app v1\n' } },
  { op: 'remotePush', branch: 'main' },
];

/** The teammate scenario: origin gains a commit the local repo has not seen. */
const TEAMMATE_README: SetupOp = {
  op: 'remoteCommit',
  message: 'teammate adds readme',
  files: { 'README.md': '# team\n' },
};

describe('remote simulation: setup ops', () => {
  it('remotePush creates origin with a synced tracking ref', async () => {
    const { engine } = await makeEngine();
    const snap = await engine.buildLevel(CLONED);
    expect(snap.remote).toBeDefined();
    expect(snap.remoteBranches['origin/main']).toBe(snap.branches.main);
    expect(snap.remote!.branches.main).toBe(snap.branches.main);
    expect(pred('remoteSynced', snap, 'main')).toBe(true);
    expect(pred('trackingSet', snap, 'origin/main')).toBe(true);
  });

  it('remoteCommit moves origin while the local cache stays stale', async () => {
    const { engine } = await makeEngine();
    const snap = await engine.buildLevel([...CLONED, TEAMMATE_README]);
    expect(snap.remote!.branches.main).not.toBe(snap.branches.main);
    // The local cache still points where the clone left it.
    expect(snap.remoteBranches['origin/main']).toBe(snap.branches.main);
    expect(pred('remoteAhead', snap, 'main')).toBe(true);
    // And the teammate commit is invisible locally: its objects are not here.
    expect(pred('commitReachable', snap, 'main', 'teammate adds readme')).toBe(false);
    expect(pred('commitReachable', snap, 'origin/main', 'teammate adds readme')).toBe(false);
  });

  it('buildLevel starts clean: no origin unless the setup makes one', async () => {
    const { engine } = await makeEngine();
    const withRemote = await engine.buildLevel(CLONED);
    expect(withRemote.remote).toBeDefined();
    const without = await engine.buildLevel(INITIAL_SETUP);
    expect(without.remote).toBeUndefined();
    expect(without.remoteBranches).toEqual({});
  });
});

describe('remote simulation: fetch / pull / push', () => {
  it('GATE: fetch moves origin/main while main stays put', async () => {
    const { engine } = await makeEngine();
    const before = await engine.buildLevel([...CLONED, TEAMMATE_README]);
    const r = await engine.run('git fetch');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('main');
    expect(r.stdout).toContain('origin/main');

    const s = r.snapshot;
    // The cache refreshed: origin/main now points at the teammate commit.
    expect(s.remoteBranches['origin/main']).toBe(s.remote!.branches.main);
    // main did not move, and now visibly lacks the teammate commit.
    expect(s.branches.main).toBe(before.branches.main);
    expect(pred('commitReachable', s, 'origin/main', 'teammate adds readme')).toBe(true);
    expect(pred('commitReachable', s, 'main', 'teammate adds readme')).toBe(false);
  });

  it('pull fast-forwards main onto the fetched tip', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([...CLONED, TEAMMATE_README]);
    const r = await engine.run('git pull');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('Fast-forward');
    const s = r.snapshot;
    expect(s.branches.main).toBe(s.remoteBranches['origin/main']);
    expect(pred('commitCount', s, 'main', 2)).toBe(true);
    expect(pred('remoteAhead', s, 'main')).toBe(false);
  });

  it('push publishes local commits and moves the tracking ref', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(CLONED);
    await engine.editFile('app.txt', 'app v2\n');
    await engine.run('git add app.txt');
    await engine.run('git commit -m "app v2"');
    const r = await engine.run('git push');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('main -> main');
    const s = r.snapshot;
    expect(s.remote!.branches.main).toBe(s.branches.main);
    expect(s.remoteBranches['origin/main']).toBe(s.branches.main);
    expect(pred('remoteSynced', s, 'main')).toBe(true);
  });

  it('push rejects non-fast-forward; pull joins the histories; push succeeds', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([
      ...CLONED,
      { op: 'remoteCommit', message: 'teammate ships v2', files: { 'app.txt': 'app v2\n' } },
    ]);
    await engine.editFile('notes.txt', 'field notes\n');
    await engine.run('git add notes.txt');
    await engine.run('git commit -m "add field notes"');

    const rejected = await engine.run('git push');
    expect(rejected.ok).toBe(false);
    expect(rejected.stderr).toContain('non-fast-forward');
    // The rejection changed nothing on origin.
    expect(pred('remoteSynced', rejected.snapshot, 'main')).toBe(false);
    expect(pred('commitReachable', rejected.snapshot, 'origin/main', 'teammate ships v2')).toBe(
      false,
    );

    const pulled = await engine.run('git pull');
    expect(pulled.ok).toBe(true);
    expect(pulled.stdout).toContain("Merge made by the 'ort' strategy.");

    const pushed = await engine.run('git push');
    expect(pushed.ok).toBe(true);
    const s = pushed.snapshot;
    expect(pred('remoteSynced', s, 'main')).toBe(true);
    expect(pred('commitReachable', s, 'origin/main', 'teammate ships v2')).toBe(true);
    expect(pred('commitReachable', s, 'origin/main', 'add field notes')).toBe(true);
    // base + my notes + the teammate commit + the merge that joins them.
    expect(pred('commitCount', s, 'main', 4)).toBe(true);
  });

  it('force-with-lease refuses on a stale cache, then rewrites origin after fetch', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([
      ...CLONED,
      { op: 'remoteCommit', message: 'debug junk', files: { 'debug.txt': 'junk\n' } },
    ]);

    const stale = await engine.run('git push --force-with-lease');
    expect(stale.ok).toBe(false);
    expect(stale.stderr).toContain('stale info');

    await engine.run('git fetch');
    const r = await engine.run('git push --force-with-lease');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('forced update');
    const s = r.snapshot;
    expect(pred('remoteSynced', s, 'main')).toBe(true);
    // The junk commit is gone from origin's history.
    expect(pred('commitCount', s, 'origin/main', 1)).toBe(true);
  });

  it('push creates a new branch on origin', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(CLONED);
    await engine.run('git branch feature');
    const r = await engine.run('git push origin feature');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('[new branch]');
    expect(r.stdout).toContain('feature -> feature');
    const s = r.snapshot;
    expect(s.remote!.branches.feature).toBe(s.branches.feature);
    expect(s.remoteBranches['origin/feature']).toBe(s.branches.feature);
  });

  it('Everything up-to-date when there is nothing to push', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(CLONED);
    const r = await engine.run('git push');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('Everything up-to-date');
  });
});

describe('remote simulation: failure text and status', () => {
  it('fetch, pull, and push fail cleanly when the level has no origin', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const fetchR = await engine.run('git fetch');
    expect(fetchR.ok).toBe(false);
    expect(fetchR.stderr).toContain('does not appear to be a git repository');
    const pullR = await engine.run('git pull');
    expect(pullR.ok).toBe(false);
    expect(pullR.stderr).toContain('does not appear to be a git repository');
    const pushR = await engine.run('git push');
    expect(pushR.ok).toBe(false);
    expect(pushR.stderr).toContain('No configured push destination');
  });

  it('git remote lists origin; -v shows both directions', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(CLONED);
    expect((await engine.run('git remote')).stdout).toBe('origin\n');
    const v = await engine.run('git remote -v');
    expect(v.stdout).toContain('origin');
    expect(v.stdout).toContain('(fetch)');
    expect(v.stdout).toContain('(push)');
    // No origin: real git prints nothing.
    await engine.buildLevel(INITIAL_SETUP);
    expect((await engine.run('git remote')).stdout).toBe('');
  });

  it('git status reports ahead, behind, and diverged against the tracking ref', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(CLONED);

    await engine.editFile('app.txt', 'app v2\n');
    await engine.run('git add app.txt');
    await engine.run('git commit -m "app v2"');
    const ahead = await engine.run('git status');
    expect(ahead.stdout).toContain("Your branch is ahead of 'origin/main' by 1 commit.");
    const short = await engine.run('git status -sb');
    expect(short.stdout).toContain('## main...origin/main [ahead 1]');

    // Now the teammate lands something; after fetch, we have diverged 1/1.
    const { engine: e2 } = await makeEngine();
    await e2.buildLevel([...CLONED, TEAMMATE_README]);
    const stale = await e2.run('git status');
    expect(stale.stdout).toContain("Your branch is up to date with 'origin/main'.");
    await e2.run('git fetch');
    const behind = await e2.run('git status');
    expect(behind.stdout).toContain("Your branch is behind 'origin/main' by 1 commit.");

    await e2.editFile('notes.txt', 'mine\n');
    await e2.run('git add notes.txt');
    await e2.run('git commit -m "my notes"');
    const diverged = await e2.run('git status');
    expect(diverged.stdout).toContain("Your branch and 'origin/main' have diverged,");
    expect(diverged.stdout).toContain('and have 1 and 1 different commits each, respectively.');
  });

  it('git clone answers in-fiction instead of simulating a clone', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const r = await engine.run('git clone https://example.com/x.git');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('pre-cloned');
  });
});
