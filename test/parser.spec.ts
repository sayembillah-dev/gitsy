import { describe, expect, it } from 'vitest';
import { parseCommand, tokenize } from '@/engine/parser';

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('git  status')).toEqual(['git', 'status']);
  });

  it('keeps quoted strings together', () => {
    expect(tokenize('commit -m "add two files"')).toEqual(['commit', '-m', 'add two files']);
    expect(tokenize("commit -m 'single quotes'")).toEqual(['commit', '-m', 'single quotes']);
  });

  it('supports glued values like -m"msg"', () => {
    expect(tokenize('commit -m"glued message"')).toEqual(['commit', '-mglued message']);
  });

  it('returns null on an unterminated quote', () => {
    expect(tokenize('commit -m "oops')).toBeNull();
  });
});

describe('parseCommand', () => {
  it('accepts an optional git prefix', () => {
    const bare = parseCommand('status');
    const prefixed = parseCommand('git status');
    expect(bare).toEqual({ ok: true, command: { cmd: 'status', short: false, showBranch: false } });
    expect(prefixed).toEqual(bare);
  });

  it('parses commit -m variants', () => {
    expect(parseCommand('git commit -m "hello world"')).toEqual({
      ok: true,
      command: { cmd: 'commit', messages: ['hello world'], allowEmpty: false },
    });
    const multi = parseCommand('git commit -m "title" -m "body"');
    expect(multi.ok && multi.command.cmd === 'commit' ? multi.command.messages : []).toEqual([
      'title',
      'body',
    ]);
    const glued = parseCommand('git commit -m"glued"');
    expect(glued.ok && glued.command.cmd === 'commit' ? glued.command.messages : []).toEqual([
      'glued',
    ]);
  });

  it('rejects a missing -m value', () => {
    const r = parseCommand('git commit -m');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stderr).toContain('requires a value');
  });

  it('rejects unknown options with real-shaped text', () => {
    const r = parseCommand('git commit --yolo');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stderr).toContain("error: unknown option 'yolo'");
      expect(r.stderr).toContain('usage: git commit');
    }
  });

  it('rejects unknown commands', () => {
    const r = parseCommand('git frobnicate');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stderr).toContain("git: 'frobnicate' is not a git command");
  });

  it('routes later-act commands to unsupported', () => {
    expect(parseCommand('git rebase -i main')).toEqual({
      ok: true,
      command: { cmd: 'unsupported', name: 'rebase', args: ['-i', 'main'] },
    });
  });

  it('parses add forms', () => {
    expect(parseCommand('git add .')).toEqual({
      ok: true,
      command: { cmd: 'add', paths: ['.'], all: true, patch: false },
    });
    expect(parseCommand('git add -A')).toEqual({
      ok: true,
      command: { cmd: 'add', paths: [], all: true, patch: false },
    });
    expect(parseCommand('git add -p a.txt')).toEqual({
      ok: true,
      command: { cmd: 'add', paths: ['a.txt'], all: false, patch: true },
    });
    expect(parseCommand('git add a.txt b.txt')).toEqual({
      ok: true,
      command: { cmd: 'add', paths: ['a.txt', 'b.txt'], all: false, patch: false },
    });
  });

  it('parses log flags', () => {
    expect(parseCommand('git log --oneline -3')).toEqual({
      ok: true,
      command: { cmd: 'log', oneline: true, maxCount: 3 },
    });
    expect(parseCommand('git log --max-count=2')).toEqual({
      ok: true,
      command: { cmd: 'log', oneline: false, maxCount: 2 },
    });
    expect(parseCommand('git log -n 4')).toEqual({
      ok: true,
      command: { cmd: 'log', oneline: false, maxCount: 4 },
    });
  });

  it('parses restore', () => {
    expect(parseCommand('git restore a.txt')).toEqual({
      ok: true,
      command: { cmd: 'restore', paths: ['a.txt'], staged: false, worktree: true },
    });
    expect(parseCommand('git restore --staged a.txt')).toEqual({
      ok: true,
      command: { cmd: 'restore', paths: ['a.txt'], staged: true, worktree: false },
    });
    expect(parseCommand('git restore').ok).toBe(false);
  });

  it('parses diff', () => {
    expect(parseCommand('git diff')).toEqual({
      ok: true,
      command: { cmd: 'diff', staged: false, paths: [] },
    });
    expect(parseCommand('git diff --cached')).toEqual({
      ok: true,
      command: { cmd: 'diff', staged: true, paths: [] },
    });
    expect(parseCommand('git diff --staged a.txt')).toEqual({
      ok: true,
      command: { cmd: 'diff', staged: true, paths: ['a.txt'] },
    });
  });
});
