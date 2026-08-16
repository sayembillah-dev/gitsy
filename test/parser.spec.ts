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
      command: { cmd: 'commit', messages: ['hello world'], allowEmpty: false, amend: false, noEdit: false },
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
    // Phase 10 made rebase/stash/reflog real; show/rm/mv/config stay parked.
    expect(parseCommand('git show HEAD')).toEqual({
      ok: true,
      command: { cmd: 'unsupported', name: 'show', args: ['HEAD'] },
    });
  });

  it('parses the Act 4 grammar', () => {
    expect(parseCommand('git commit --amend -m "fixed"')).toEqual({
      ok: true,
      command: { cmd: 'commit', messages: ['fixed'], allowEmpty: false, amend: true, noEdit: false },
    });
    expect(parseCommand('git revert HEAD~1')).toEqual({
      ok: true,
      command: { cmd: 'revert', ref: 'HEAD~1' },
    });
    expect(parseCommand('git cherry-pick fix~1')).toEqual({
      ok: true,
      command: { cmd: 'cherry-pick', ref: 'fix~1' },
    });
    expect(parseCommand('git rebase -i main')).toEqual({
      ok: true,
      command: {
        cmd: 'rebase',
        interactive: true,
        onto: null,
        upstream: 'main',
        branch: null,
        continueRebase: false,
        abort: false,
      },
    });
    expect(parseCommand('git rebase --continue')).toEqual({
      ok: true,
      command: {
        cmd: 'rebase',
        interactive: false,
        onto: null,
        upstream: null,
        branch: null,
        continueRebase: true,
        abort: false,
      },
    });
    expect(parseCommand('git stash')).toEqual({
      ok: true,
      command: { cmd: 'stash', sub: 'push', message: null },
    });
    expect(parseCommand('git stash push -m "hold this"')).toEqual({
      ok: true,
      command: { cmd: 'stash', sub: 'push', message: 'hold this' },
    });
    expect(parseCommand('git stash pop')).toEqual({
      ok: true,
      command: { cmd: 'stash', sub: 'pop', message: null },
    });
  });

  it('parses the Act 5 grammar', () => {
    expect(parseCommand('git reflog')).toEqual({
      ok: true,
      command: { cmd: 'reflog', ref: null },
    });
    expect(parseCommand('git reflog main')).toEqual({
      ok: true,
      command: { cmd: 'reflog', ref: 'main' },
    });
    expect(parseCommand('git bisect start HEAD HEAD~5')).toEqual({
      ok: true,
      command: { cmd: 'bisect', sub: 'start', refs: ['HEAD', 'HEAD~5'] },
    });
    expect(parseCommand('git bisect good')).toEqual({
      ok: true,
      command: { cmd: 'bisect', sub: 'good', refs: [] },
    });
    expect(parseCommand('git blame app.txt')).toEqual({
      ok: true,
      command: { cmd: 'blame', file: 'app.txt' },
    });
    expect(parseCommand('git blame -C -M app.txt')).toEqual({
      ok: true,
      command: { cmd: 'blame', file: 'app.txt' },
    });
    expect(parseCommand('git log -S hunter2 --oneline')).toEqual({
      ok: true,
      command: { cmd: 'log', oneline: true, maxCount: null, pickaxe: 'hunter2' },
    });
    expect(parseCommand('git log -S "api key"')).toEqual({
      ok: true,
      command: { cmd: 'log', oneline: false, maxCount: null, pickaxe: 'api key' },
    });
    expect(parseCommand('git worktree add -b hotfix hotfix-dir')).toEqual({
      ok: true,
      command: { cmd: 'worktree', sub: 'add', path: 'hotfix-dir', branch: 'hotfix', createBranch: true },
    });
    expect(parseCommand('git worktree list')).toEqual({
      ok: true,
      command: { cmd: 'worktree', sub: 'list', path: null, branch: null, createBranch: false },
    });
    expect(parseCommand('git switch --detach HEAD~1')).toEqual({
      ok: true,
      command: { cmd: 'switch', name: 'HEAD~1', create: false, detach: true },
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
      command: { cmd: 'log', oneline: true, maxCount: 3, pickaxe: null },
    });
    expect(parseCommand('git log --max-count=2')).toEqual({
      ok: true,
      command: { cmd: 'log', oneline: false, maxCount: 2, pickaxe: null },
    });
    expect(parseCommand('git log -n 4')).toEqual({
      ok: true,
      command: { cmd: 'log', oneline: false, maxCount: 4, pickaxe: null },
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
