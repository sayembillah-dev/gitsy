// Engine-side `git add -p` sessions (Phase 3): hunk prompts, per-answer
// stepping, and partial staging that never disturbs the workdir bytes.

import { describe, expect, it } from 'vitest';
import { applyHunks, computeHunks } from '@/engine/diff';
import type { SetupOp } from '@/core/types';
import { makeEngine } from './engine.helpers';

const TWELVE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

const SETUP: SetupOp[] = [
  { op: 'commit', message: 'base', files: { 'big.txt': TWELVE } },
  {
    op: 'write',
    path: 'big.txt',
    content: TWELVE.replace('line 2', 'line 2 edited').replace('line 11', 'line 11 edited'),
  },
];

describe('git add -p', () => {
  it('offers hunks one at a time and stages only the accepted ones', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);

    const start = await engine.run('git add -p');
    expect(start.stdout).toContain('diff --git a/big.txt b/big.txt');
    expect(start.stdout).toContain('-line 2');
    expect(start.stdout).toContain('+line 2 edited');
    expect(start.stdout.endsWith('[y,n,q,a,d,/,e,?]? ')).toBe(true);
    // both changes are far apart: two hunks
    expect(start.stdout).not.toContain('line 11 edited');

    const skip = await engine.answer('n');
    expect(skip.stdout).toContain('+line 11 edited');
    expect(skip.stdout.endsWith('[y,n,q,a,d,/,e,?]? ')).toBe(true);

    const take = await engine.answer('y');
    expect(take.stdout).toBe('');

    const snap = take.snapshot;
    const staged = snap.index.find((f) => f.path === 'big.txt');
    const workdir = snap.workingTree.find((f) => f.path === 'big.txt');
    const expectedStaged = applyHunks(
      TWELVE,
      computeHunks(TWELVE, TWELVE.replace('line 11', 'line 11 edited')),
    );
    expect(staged?.content).toBe(expectedStaged);
    expect(staged?.status).toBe('staged');
    expect(workdir?.content).toContain('line 2 edited'); // workdir bytes untouched
    expect(workdir?.status).toBe('modified'); // hunk 1 still unstaged
  });

  it('q quits without staging anything further', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    await engine.run('git add -p');
    const quit = await engine.answer('q');
    expect(quit.stdout).toBe('');
    const staged = quit.snapshot.index.find((f) => f.path === 'big.txt');
    expect(staged?.status).toBe('clean'); // index still matches HEAD
  });

  it('re-prompts on unknown keys and explains s and e within scope', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    await engine.run('git add -p');
    const huh = await engine.answer('z');
    expect(huh.stdout.endsWith('[y,n,q,a,d,/,e,?]? ')).toBe(true);
    const split = await engine.answer('s');
    expect(split.stdout).toContain('Sorry, cannot split this hunk');
    const edit = await engine.answer('e');
    expect(edit.stdout).toContain('not available');
    const help = await engine.answer('?');
    expect(help.stdout).toContain('y - stage this hunk');
    await engine.answer('q');
  });

  it('a accepts the rest of the file and finishes the session', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(SETUP);
    await engine.run('git add -p big.txt');
    const all = await engine.answer('a');
    expect(all.stdout).toBe('');
    const staged = all.snapshot.index.find((f) => f.path === 'big.txt');
    expect(staged?.content).toContain('line 2 edited');
    expect(staged?.content).toContain('line 11 edited');
    expect(all.snapshot.workingTree.find((f) => f.path === 'big.txt')?.status).toBe('clean');
  });

  it('prints nothing when there are no unstaged tracked changes', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([{ op: 'commit', message: 'base', files: { 'a.txt': 'a\n' } }]);
    const r = await engine.run('git add -p');
    expect(r.stdout).toBe('');
    const noSession = await engine.answer('y');
    expect(noSession.ok).toBe(false);
    expect(noSession.stderr).toContain('no patch session');
  });
});
