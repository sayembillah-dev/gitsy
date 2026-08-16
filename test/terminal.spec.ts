// Phase 3 gate, headless: TerminalSession is the exact code path the xterm
// wrapper uses, so driving it line by line IS playing a level by typing.
// Covers the in-fiction lock, builtins, real engine output/errors, the patch
// flow through the session, and full start-to-finish playthroughs.

import { describe, expect, it } from 'vitest';
import { getLevel } from '@/content';
import { levelDefOf } from '@/core/levelSchema';
import { TerminalSession } from '@/game/terminalCore';
import { makeEngine } from './engine.helpers';

async function boot(levelId: string) {
  const file = getLevel(levelId);
  if (!file) throw new Error(`no level ${levelId}`);
  const { engine } = await makeEngine();
  await engine.buildLevel(file.setup);
  const log: string[] = [];
  const session = new TerminalSession({
    engine,
    level: levelDefOf(file),
    onLog: (entry) => log.push(entry),
  });
  return { session, log };
}

describe('terminal gate: play a level start to finish by typing only', () => {
  it('act1-01 completes through its canonical commands with real output', async () => {
    const { session, log } = await boot('act1-01-first-commit');

    const status = await session.submit('git status');
    expect(status.stdout).toContain('Untracked files');
    expect(status.stdout).toContain('hello.txt');
    expect(status.complete).toBe(false);

    await session.submit('git add hello.txt');
    const commit = await session.submit('git commit -m "hello world"');
    expect(commit.stdout).toContain('hello world');
    expect(commit.complete).toBe(true);
    expect(log).toEqual(['git status', 'git add hello.txt', 'git commit -m "hello world"']);
  });

  it('act1-02 completes via diff and restore', async () => {
    const { session } = await boot('act1-02-take-it-back');
    const diff = await session.submit('git diff');
    expect(diff.stdout).toContain('-version one');
    expect(diff.stdout).toContain('+version two, much worse');
    const restore = await session.submit('git restore draft.txt');
    expect(restore.complete).toBe(true);
  });

  it('act1-03 completes inside its maxCommands constraint', async () => {
    const { session } = await boot('act1-03-stage-with-intent');
    // locked commands are free: they never reach the engine
    const locked = await session.submit('git rebase');
    expect(locked.stderr).toBe('rebase: not yet unlocked - reach Act 4\n');
    expect(session.commandCount).toBe(0);

    for (const line of ['git add app.txt', 'git commit -m "fix app"', 'git add notes.txt']) {
      await session.submit(line);
    }
    const last = await session.submit('git commit -m "fix notes"');
    expect(session.commandCount).toBe(4);
    expect(last.complete).toBe(true);
  });
});

describe('terminal gate: errors and builtins', () => {
  it('unknown commands get the real git-shaped error', async () => {
    const { session } = await boot('act1-01-first-commit');
    const r = await session.submit('git frobnicate');
    expect(r.stderr).toContain("git: 'frobnicate' is not a git command");
    expect(session.commandCount).toBe(1); // reached the engine, so it counts
  });

  it('failed commands produce real errors and still count', async () => {
    const { session } = await boot('act1-01-first-commit');
    const r = await session.submit('git commit -m "nothing staged"');
    expect(r.stdout).toContain('no changes added to commit');
    expect(r.complete).toBe(false);
    expect(session.commandCount).toBe(1);
  });

  it('help lists the unlocked set; clear asks the UI to wipe', async () => {
    const { session } = await boot('act1-01-first-commit');
    const help = await session.submit('help');
    expect(help.stdout).toContain('status');
    expect(help.stdout).toContain('commit');
    const clear = await session.submit('clear');
    expect(clear.clear).toBe(true);
    expect(session.completions()).toEqual(expect.arrayContaining(['status', 'add', 'help']));
  });

  it('tab completion is limited to the unlocked set plus builtins', async () => {
    const { session } = await boot('act1-01-first-commit');
    expect(session.completions()).not.toContain('rebase');
    expect(session.completions()).not.toContain('merge');
  });
});

describe('terminal gate: interactive patch through the session', () => {
  it('git add -p switches the session into answer routing', async () => {
    const { session, log } = await boot('act1-02-take-it-back');
    const start = await session.submit('git add -p');
    expect(start.stdout).toContain('Stage this hunk [y,n,q,a,d,/,e,?]?');
    expect(session.inPatch).toBe(true);

    const done = await session.submit('y');
    expect(session.inPatch).toBe(false);
    expect(log).toEqual(['git add -p', 'patch-answer: y']);
    // staging the bad edit is not the goal: the level stays incomplete
    expect(done.complete).toBe(false);
    const staged = done.snapshot?.index.find((f) => f.path === 'draft.txt');
    expect(staged?.status).toBe('staged');
  });
});
