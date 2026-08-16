// The Phase 2 gate (BUILD-PLAN): load every level JSON, replay its canonical
// solution through the real engine, assert complete === true; then replay at
// least one deliberately wrong solution per level and assert complete ===
// false. This suite runs forever: it is what stops a later phase from
// silently breaking an earlier level.

import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluate } from '@/core/evaluate';
import { levelDefOf, parseLevelFile, type LevelFile } from '@/core/levelSchema';
import { createEngine } from '@/engine/createEngine';
import { commandCountOf, replayEntries } from '@/game/replay';

const LEVELS_DIR = join(process.cwd(), 'src', 'content', 'levels');

function loadLevels(): { name: string; level: LevelFile }[] {
  const names = readdirSync(LEVELS_DIR).filter((n) => n.endsWith('.json'));
  return names.map((name) => ({
    name,
    level: parseLevelFile(JSON.parse(readFileSync(join(LEVELS_DIR, name), 'utf8'))),
  }));
}

// Solutions may contain `patch-answer:` and `edit-file:` directives (Phases
// 3 and 5): the same replay the Phase 6 undo/refresh path uses, so the gate
// and the game share one truth.
async function replay(setup: LevelFile['setup'], commands: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'gitsy-level-'));
  const engine = createEngine({ fs: nodeFs, dir });
  const snapshot = await replayEntries(engine, setup, commands);
  return { snapshot, commandCount: commandCountOf(commands) };
}

const levels = loadLevels();

describe('level files', () => {
  it('ships at least one level and every file validates', () => {
    expect(levels.length).toBeGreaterThan(0);
    for (const { name, level } of levels) {
      expect(level.id, `${name} id matches file name`).toBe(name.replace(/\.json$/, ''));
    }
  });

  for (const { name, level } of levels) {
    describe(name, () => {
      it('canonical solution completes the level', async () => {
        const { snapshot, commandCount } = await replay(level.setup, level.solution);
        const result = evaluate(snapshot, levelDefOf(level), { commandCount });
        expect(
          result.goals.filter((g) => !g.passed).map((g) => g.label),
          'all goals pass',
        ).toEqual([]);
        expect(result.constraintsViolated, 'no constraints violated').toEqual([]);
        expect(result.complete).toBe(true);
      });

      for (const [i, wrong] of level.wrongSolutions.entries()) {
        it(`wrong solution #${i + 1} does not complete the level`, async () => {
          const { snapshot, commandCount } = await replay(level.setup, wrong);
          const result = evaluate(snapshot, levelDefOf(level), { commandCount });
          expect(result.complete).toBe(false);
        });
      }
    });
  }
});
