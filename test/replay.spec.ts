// The Phase 6 gate (BUILD-PLAN): the full loop survives refresh. Playing by
// typing, then replaying the persisted log into a fresh engine, lands on the
// same structural state; undo (replay log[0..n-1]) lands one step earlier.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluate } from '@/core/evaluate';
import { levelDefOf, parseLevelFile } from '@/core/levelSchema';
import { commandCountOf, replayEntries } from '@/game/replay';
import { TerminalSession } from '@/game/terminalCore';
import { makeEngine } from './engine.helpers';

const level = parseLevelFile(
  JSON.parse(
    readFileSync(
      join(process.cwd(), 'src', 'content', 'levels', 'act1-01-first-commit.json'),
      'utf8',
    ),
  ),
);

describe('deterministic replay', () => {
  it('replaying the log reproduces the played state (refresh survives)', async () => {
    const { engine } = await makeEngine();
    const entries: string[] = [];
    const session = new TerminalSession({
      engine,
      level: levelDefOf(level),
      onLog: (e) => entries.push(e),
    });
    await engine.buildLevel(level.setup);
    let playedSnap = await engine.snapshot();
    for (const line of level.solution) {
      const r = await session.submit(line);
      if (r.snapshot) playedSnap = r.snapshot;
    }
    const playedEval = evaluate(playedSnap, levelDefOf(level), {
      commandCount: session.commandCount,
    });

    // Fresh engine + the log: what a page refresh does.
    const fresh = await makeEngine();
    const replayed = await replayEntries(fresh.engine, level.setup, entries);
    const reEval = evaluate(replayed, levelDefOf(level), {
      commandCount: commandCountOf(entries),
    });

    expect(reEval.goals).toEqual(playedEval.goals);
    expect(reEval.complete).toBe(true);
    // Structural identity: struct hashes and panels match (git SHAs may not;
    // they are wall-clock display fields and never compared).
    expect(Object.keys(replayed.commits).sort()).toEqual(
      Object.keys(playedSnap.commits).sort(),
    );
    expect(replayed.workingTree).toEqual(playedSnap.workingTree);
    expect(replayed.index).toEqual(playedSnap.index);
  });

  it('undo = replay log[0..n-1]: the commit never happened', async () => {
    const fresh = await makeEngine();
    const prefix = level.solution.slice(0, -1);
    const undone = await replayEntries(fresh.engine, level.setup, prefix);
    const result = evaluate(undone, levelDefOf(level), {
      commandCount: commandCountOf(prefix),
    });
    expect(result.complete).toBe(false);
    expect(undone.index.find((f) => f.path === 'hello.txt')?.status).toBe('staged');
  });

  it('commandCountOf ignores patch-answer and edit-file directives', () => {
    expect(
      commandCountOf(['git add .', 'patch-answer: y', 'edit-file: a.txt x%0A', 'git status']),
    ).toBe(2);
  });
});
