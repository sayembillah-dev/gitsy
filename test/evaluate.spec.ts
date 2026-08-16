import { describe, expect, it } from 'vitest';
import { evaluate } from '@/core/evaluate';
import { levelDefOf, parseLevelFile } from '@/core/levelSchema';
import type { LevelDef } from '@/core/types';
import { chainGraph, file, makeSnap } from './snap.helpers';

function level(partial: Partial<LevelDef> & Pick<LevelDef, 'goals'>): LevelDef {
  return {
    id: 'test-level',
    act: 1,
    title: 'test',
    brief: 'test',
    setup: [],
    unlocked: ['status'],
    hints: ['hint'],
    ...partial,
  };
}

describe('evaluate: goals and constraints', () => {
  it('maps every goal to a labelled pass/fail', () => {
    const g = chainGraph();
    const snap = makeSnap({ commits: g.commits, branches: { main: g.c3.hash } });
    const result = evaluate(
      snap,
      level({
        goals: [
          { assert: 'commitCount', args: ['HEAD', 3], label: 'three commits' },
          { assert: 'commitReachable', args: ['HEAD', 'nope'], label: 'has nope' },
        ],
      }),
    );
    expect(result.goals).toEqual([
      { label: 'three commits', passed: true },
      { label: 'has nope', passed: false },
    ]);
    expect(result.complete).toBe(false);
  });

  it('complete requires all goals and zero violated constraints', () => {
    const snap = makeSnap({
      workingTree: [file('a.txt', 'clean', 'a')],
      index: [file('a.txt', 'clean', 'a')],
    });
    const ok = evaluate(
      snap,
      level({
        goals: [{ assert: 'workingTreeClean', label: 'clean' }],
        constraints: [{ assert: 'maxCommands', args: [3], label: 'three or fewer' }],
      }),
      { commandCount: 2 },
    );
    expect(ok.complete).toBe(true);
    expect(ok.constraintsViolated).toEqual([]);

    const over = evaluate(
      snap,
      level({
        goals: [{ assert: 'workingTreeClean', label: 'clean' }],
        constraints: [{ assert: 'maxCommands', args: [3], label: 'three or fewer' }],
      }),
      { commandCount: 4 },
    );
    expect(over.complete).toBe(false);
    expect(over.constraintsViolated).toEqual(['three or fewer']);
  });

  it('fails closed on a predicate the registry does not know', () => {
    const result = evaluate(
      makeSnap(),
      level({ goals: [{ assert: 'notARealPredicate', label: 'bogus' }] }),
    );
    expect(result.goals).toEqual([{ label: 'bogus', passed: false }]);
    expect(result.complete).toBe(false);
  });
});

describe('evaluate: diagnostics', () => {
  const snap = makeSnap({ workingTree: [file('draft.txt', 'modified', 'v2')] });

  it('returns the first diagnostic whose predicate is true', () => {
    const result = evaluate(
      snap,
      level({
        goals: [{ assert: 'workingTreeClean', label: 'clean' }],
        diagnostics: [
          { when: 'fileModified', args: ['draft.txt'], say: 'draft is still dirty' },
          { when: 'fileModified', args: ['other.txt'], say: 'unrelated' },
        ],
      }),
    );
    expect(result.diagnostic).toBe('draft is still dirty');
  });

  it('omits diagnostic when nothing fires', () => {
    const clean = makeSnap({
      workingTree: [file('draft.txt', 'clean', 'v1')],
      index: [file('draft.txt', 'clean', 'v1')],
    });
    const result = evaluate(
      clean,
      level({
        goals: [{ assert: 'workingTreeClean', label: 'clean' }],
        diagnostics: [{ when: 'fileModified', args: ['draft.txt'], say: 'dirty' }],
      }),
    );
    expect(result.complete).toBe(true);
    expect('diagnostic' in result).toBe(false);
  });
});

describe('levelSchema', () => {
  const minimal = {
    id: 'act1-99-test',
    act: 1,
    title: 't',
    brief: 'b',
    setup: [],
    unlocked: ['status'],
    goals: [{ assert: 'workingTreeClean', args: [], label: 'clean' }],
    hints: ['h'],
    solution: ['git status'],
    wrongSolutions: [['git log']],
  };

  it('accepts a minimal valid level and strips test collateral for LevelDef', () => {
    const parsed = parseLevelFile(minimal);
    const def = levelDefOf(parsed);
    expect(def.id).toBe('act1-99-test');
    expect('solution' in def).toBe(false);
    expect('wrongSolutions' in def).toBe(false);
    expect(def.goals[0].assert).toBe('workingTreeClean');
  });

  it('rejects unknown predicate keys with a readable error', () => {
    const bad = { ...minimal, goals: [{ assert: 'frobnicate', label: 'x' }] };
    expect(() => parseLevelFile(bad)).toThrow(/not in the registry/);
  });

  it('rejects levels without goals, hints, solutions, or wrong solutions', () => {
    expect(() => parseLevelFile({ ...minimal, goals: [] })).toThrow(/invalid level file/);
    expect(() => parseLevelFile({ ...minimal, hints: [] })).toThrow(/invalid level file/);
    expect(() => parseLevelFile({ ...minimal, solution: [] })).toThrow(/invalid level file/);
    expect(() => parseLevelFile({ ...minimal, wrongSolutions: [] })).toThrow(/invalid level file/);
  });

  it('rejects malformed setup ops and bad ids', () => {
    expect(() =>
      parseLevelFile({ ...minimal, setup: [{ op: 'obliterate' }] }),
    ).toThrow(/invalid level file/);
    expect(() => parseLevelFile({ ...minimal, id: 'Bad ID' })).toThrow(/invalid level file/);
    expect(() => parseLevelFile({ ...minimal, act: 9 })).toThrow(/invalid level file/);
  });
});
