// Phase 10 gate, Act 5: reflog (and the rescue it enables), bisect, blame,
// log -S (pickaxe), worktree. Plus detached checkout, which Act 5 teaches.

import { describe, expect, it } from 'vitest';
import type { SetupOp } from '@/core/types';
import { makeEngine } from './engine.helpers';

const THREE_COMMITS: SetupOp[] = [
  { op: 'commit', message: 'add app v1', files: { 'app.txt': 'app v1\n' } },
  { op: 'commit', message: 'add search', files: { 'search.txt': 'search\n' } },
  { op: 'commit', message: 'add export', files: { 'export.txt': 'export\n' } },
];

describe('git reflog and the rescue', () => {
  it('logs setup commits, player commits, checkouts, and resets', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(THREE_COMMITS);
    const r = await engine.run('git reflog');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('HEAD@{0}: commit: add export');
    expect(r.stdout).toContain('HEAD@{2}: commit: add app v1');
  });

  it('GATE: a commit orphaned by reset --hard is found by SHA prefix and restored', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(THREE_COMMITS);
    const gone = await engine.run('git reset --hard HEAD~2');
    expect(gone.ok).toBe(true);
    let s = await engine.snapshot();
    expect(s.branches.main && s.commits[s.branches.main].message).toBe('add app v1');

    // The reflog still names the abandoned tip.
    const reflog = await engine.run('git reflog');
    const lostLine = reflog.stdout
      .split('\n')
      .find((l) => l.includes('commit: add export'));
    expect(lostLine).toBeDefined();
    const lostShort = lostLine!.split(' ')[0];

    // The SHA is unreachable from every ref; the journal scan resolves it.
    const back = await engine.run(`git reset --hard ${lostShort}`);
    expect(back.ok).toBe(true);
    s = back.snapshot;
    expect(s.commits[s.branches.main].message).toBe('add export');
    expect(s.reflog.some((e) => e.label.startsWith('reset: moving to'))).toBe(true);
  });
});

describe('detached checkout', () => {
  it('checkout <sha> detaches with the famous note; switch requires --detach', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(THREE_COMMITS);
    const refused = await engine.run('git switch HEAD~1');
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toContain('a branch is expected');

    const detached = await engine.run('git checkout HEAD~1');
    expect(detached.ok).toBe(true);
    expect(detached.stdout).toContain('detached HEAD');
    expect(detached.snapshot.head.type).toBe('detached');

    const back = await engine.run('git switch --detach main');
    expect(back.ok).toBe(true); // switch --detach accepts a branch name too
    expect(back.snapshot.head.type).toBe('detached');
  });
});

describe('git bisect', () => {
  // c1 clean, c2 clean, c3 clean, c4 BROKEN, c5 inherits, c6 inherits.
  const SETUP: SetupOp[] = [
    { op: 'commit', message: 'add app v1', files: { 'app.txt': 'app v1\n' } },
    { op: 'commit', message: 'add logging', files: { 'app.txt': 'app v1\nlog\n' } },
    { op: 'commit', message: 'tune config', files: { 'config.txt': 'config\n' } },
    { op: 'commit', message: 'refactor parser', files: { 'app.txt': 'app v1\nlog\nBROKEN\n' } },
    { op: 'commit', message: 'add tests', files: { 'tests.txt': 'tests\n' } },
    { op: 'commit', message: 'docs update', files: { 'README.md': '# app\n' } },
  ];

  it('converges on the first bad commit and parks HEAD on it', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);

    const start = await engine.run('git bisect start');
    expect(start.ok).toBe(true);
    expect(start.stdout).toContain('waiting for');

    await engine.run('git bisect bad');
    const step1 = await engine.run('git bisect good HEAD~5');
    expect(step1.ok).toBe(true);
    expect(step1.stdout).toContain('Bisecting:');
    expect(step1.snapshot.head.type).toBe('detached');
    // Midpoint of [c6..c2] is c4 (the culprit itself).
    let head = step1.snapshot.head;
    const at = (s: typeof step1.snapshot) =>
      s.head.type === 'detached' ? s.commits[s.head.at].message : null;
    expect(at(step1.snapshot)).toBe('refactor parser');

    const step2 = await engine.run('git bisect bad'); // c4 is broken
    expect(at(step2.snapshot)).toBe('tune config'); // midpoint of [c4, c3, c2]... see note
    const done = await engine.run('git bisect good'); // c3 is clean
    expect(done.ok).toBe(true);
    expect(done.stdout).toContain('is the first bad commit');
    expect(done.stdout).toContain('refactor parser');
    head = done.snapshot.head;
    expect(head.type).toBe('detached');
    expect(at(done.snapshot)).toBe('refactor parser');

    const reset = await engine.run('git bisect reset');
    expect(reset.ok).toBe(true);
    expect(reset.snapshot.head).toEqual({ type: 'branch', name: 'main' });
  });

  it('bad answers steer the search elsewhere', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    await engine.run('git bisect start');
    await engine.run('git bisect bad');
    await engine.run('git bisect good HEAD~5');
    const wrong = await engine.run('git bisect good'); // lying: c4 marked good
    expect(wrong.ok).toBe(true);
    // Candidates are now c5, c6: the search continues, not at the culprit.
    const s = wrong.snapshot;
    if (s.head.type === 'detached') {
      expect(s.commits[s.head.at].message).not.toBe('refactor parser');
    }
  });

  it('reset without a bisect in progress fails in-fiction', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(THREE_COMMITS);
    const r = await engine.run('git bisect reset');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('not bisecting');
  });
});

describe('git blame', () => {
  it('attributes each line to the commit that last touched it', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([
      { op: 'commit', message: 'add config', files: { 'config.txt': 'mode = safe\ntimeout = 30\n' } },
      { op: 'commit', message: 'tune timeout', files: { 'config.txt': 'mode = safe\ntimeout = 60\n' } },
      { op: 'commit', message: 'add app', files: { 'app.txt': 'app\n' } },
    ]);
    const r = await engine.run('git blame config.txt');
    expect(r.ok).toBe(true);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toContain('^'); // root commit gets the boundary mark
    expect(lines[0]).toContain('1) mode = safe');
    expect(lines[1]).not.toContain('^'); // line 2 changed in 'tune timeout'
    expect(lines[1]).toContain('2) timeout = 60');
    expect(lines[0].split(' ')[0]).not.toBe(lines[1].split(' ')[0]); // different commits
  });

  it('fails for a path not in HEAD', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(THREE_COMMITS);
    const r = await engine.run('git blame missing.txt');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('no such path');
  });
});

describe('git log -S (pickaxe)', () => {
  it('lists exactly the commits where the string count changed', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([
      { op: 'commit', message: 'add app', files: { 'app.txt': 'app\n' } },
      { op: 'commit', message: 'add secrets', files: { 'secrets.txt': 'api_key = hunter2\n' } },
      { op: 'commit', message: 'add feature', files: { 'feature.txt': 'f\n' } },
      { op: 'commit', message: 'remove the leaked key', files: { 'secrets.txt': 'api_key = REDACTED\n' } },
      { op: 'commit', message: 'add docs', files: { 'README.md': '# app\n' } },
    ]);
    const r = await engine.run('git log -S hunter2 --oneline');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('add secrets');
    expect(r.stdout).toContain('remove the leaked key');
    expect(r.stdout).not.toContain('add feature');
    expect(r.stdout).not.toContain('add docs');
    expect(r.stdout).not.toContain('add app');
  });
});

describe('git worktree', () => {
  const SETUP: SetupOp[] = [
    { op: 'commit', message: 'app v1', files: { 'app.txt': 'app v1\n' } },
    { op: 'write', path: 'app.txt', content: 'app v1\nhalf-done rework\n' },
  ];

  it('add -b creates the branch and registers the worktree; snapshot carries it', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    const r = await engine.run('git worktree add -b hotfix hotfix-dir');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("new branch 'hotfix'");
    expect(r.snapshot.worktrees).toEqual([{ path: 'hotfix-dir', branch: 'hotfix' }]);
    expect(r.snapshot.branches.hotfix).toBeDefined();
    // The main tree is untouched: still on main, still dirty.
    expect(r.snapshot.head).toEqual({ type: 'branch', name: 'main' });
    expect(r.snapshot.workingTree.find((f) => f.path === 'app.txt')?.status).toBe('modified');

    const list = await engine.run('git worktree list');
    expect(list.stdout).toContain('[main]');
    expect(list.stdout).toContain('hotfix-dir');
    expect(list.stdout).toContain('[hotfix]');
  });

  it('the worktree branch cannot be checked out in the main tree', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    await engine.run('git worktree add -b hotfix hotfix-dir');
    const r = await engine.run('git switch hotfix');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('already checked out');
  });

  it('remove unregisters the worktree; double-add of a path refuses', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    await engine.run('git worktree add -b hotfix hotfix-dir');
    const dup = await engine.run('git worktree add other-dir');
    // 'other-dir' with no branch: creates branch 'other-dir'; path is fresh, so ok
    expect(dup.ok).toBe(true);
    const samePath = await engine.run('git worktree add -b x hotfix-dir');
    expect(samePath.ok).toBe(false);
    expect(samePath.stderr).toContain('already exists');

    const rm = await engine.run('git worktree remove hotfix-dir');
    expect(rm.ok).toBe(true);
    expect(rm.snapshot.worktrees).toEqual([{ path: 'other-dir', branch: 'other-dir' }]);
    // The branch survives removal (real git keeps it).
    expect(rm.snapshot.branches.hotfix).toBeDefined();
  });
});
