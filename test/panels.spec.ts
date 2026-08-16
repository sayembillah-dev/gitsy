// The Phase 5 gate (BUILD-PLAN): run add, restore, commit, and reset
// --soft/--mixed/--hard and watch the correct panels change. The panels are
// a pure function of the snapshot, so "watching" means asserting
// derivePanels output after every command.

import { describe, expect, it } from 'vitest';
import type { FileEntry, LevelDef } from '@/core/types';
import { derivePanels } from '@/game/trees';
import { TerminalSession } from '@/game/terminalCore';
import { INITIAL_SETUP, makeEngine } from './engine.helpers';

const find = (files: FileEntry[], path: string): FileEntry | undefined =>
  files.find((f) => f.path === path);

describe('derivePanels', () => {
  it('an unborn HEAD yields an empty object-store panel', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel([]);
    const r = await engine.editFile('new.txt', 'fresh\n');
    const panels = derivePanels(r.snapshot);
    expect(panels.head).toEqual([]);
    expect(panels.index).toEqual([]);
    expect(find(panels.working, 'new.txt')?.status).toBe('untracked');
  });

  it('the object-store panel mirrors the HEAD tree', async () => {
    const { engine } = await makeEngine();
    const snap = await engine.buildLevel(INITIAL_SETUP);
    const panels = derivePanels(snap);
    expect(find(panels.head, 'a.txt')).toMatchObject({ status: 'clean', content: 'alpha\n' });
    expect(find(panels.head, 'b.txt')).toMatchObject({ status: 'clean', content: 'bravo\n' });
  });
});

describe('three-trees gate', () => {
  it('add, restore, commit, reset move files between the correct panels', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const panels = async () => derivePanels(await engine.snapshot());

    // Edit: only the working tree panel changes.
    await engine.editFile('a.txt', 'alpha two\n');
    let p = await panels();
    expect(find(p.working, 'a.txt')?.status).toBe('modified');
    expect(find(p.index, 'a.txt')?.status).toBe('clean');
    expect(find(p.head, 'a.txt')?.content).toBe('alpha\n');

    // git add: workdir goes clean, the index panel shows the staged change,
    // the object store is untouched.
    await engine.run('git add a.txt');
    p = await panels();
    expect(find(p.working, 'a.txt')?.status).toBe('clean');
    expect(find(p.index, 'a.txt')?.status).toBe('staged');
    expect(find(p.index, 'a.txt')?.content).toBe('alpha two\n');
    expect(find(p.head, 'a.txt')?.content).toBe('alpha\n');

    // git restore --staged: the change falls back to the working tree panel.
    await engine.run('git restore --staged a.txt');
    p = await panels();
    expect(find(p.working, 'a.txt')?.status).toBe('modified');
    expect(find(p.index, 'a.txt')?.status).toBe('clean');

    // git commit: the object store panel picks the change up, all clean.
    await engine.run('git add a.txt');
    await engine.run('git commit -m second');
    p = await panels();
    expect(find(p.working, 'a.txt')?.status).toBe('clean');
    expect(find(p.index, 'a.txt')?.status).toBe('clean');
    expect(find(p.head, 'a.txt')?.content).toBe('alpha two\n');

    // Edit + stage, then reset --soft: the ref moves but the staged change
    // stays in the index panel.
    await engine.editFile('a.txt', 'alpha three\n');
    await engine.run('git add a.txt');
    await engine.run('git reset --soft HEAD~1');
    p = await panels();
    expect(find(p.head, 'a.txt')?.content).toBe('alpha\n');
    expect(find(p.index, 'a.txt')?.status).toBe('staged');
    expect(find(p.working, 'a.txt')?.status).toBe('clean');

    // reset --mixed: the change drops from the index into the working tree.
    await engine.run('git reset --mixed HEAD');
    p = await panels();
    expect(find(p.index, 'a.txt')?.status).toBe('clean');
    expect(find(p.working, 'a.txt')?.status).toBe('modified');
    expect(find(p.working, 'a.txt')?.content).toBe('alpha three\n');

    // reset --hard: all three panels agree on HEAD content again.
    await engine.run('git reset --hard HEAD');
    p = await panels();
    expect(find(p.working, 'a.txt')?.status).toBe('clean');
    expect(find(p.working, 'a.txt')?.content).toBe('alpha\n');
    expect(find(p.index, 'a.txt')?.status).toBe('clean');
    expect(find(p.head, 'a.txt')?.content).toBe('alpha\n');
  });
});

describe('TerminalSession.editFile', () => {
  const EDIT_LEVEL: LevelDef = {
    id: 'test-edit',
    act: 1,
    title: 'edit test',
    brief: '',
    setup: [],
    unlocked: ['add', 'commit', 'status'],
    goals: [{ assert: 'fileModified', args: ['a.txt'], label: 'a.txt modified' }],
    hints: [],
  };

  it('saves bytes, logs an edit-file directive, and re-evaluates goals', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    const log: string[] = [];
    const session = new TerminalSession({
      engine,
      level: EDIT_LEVEL,
      onLog: (entry) => log.push(entry),
    });

    const r = await session.editFile('a.txt', 'changed\n');
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true); // the fileModified goal fires
    expect(log).toEqual(['edit-file: a.txt changed%0A']);
    expect(find(r.snapshot.workingTree, 'a.txt')?.status).toBe('modified');
  });

  it('rejects paths outside the workdir', async () => {
    const { engine } = await makeEngine();
    await engine.buildLevel(INITIAL_SETUP);
    for (const bad of ['../escape.txt', '.git/HEAD', '/abs.txt', '']) {
      const r = await engine.editFile(bad, 'x\n');
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain('fatal: invalid path');
    }
  });
});
