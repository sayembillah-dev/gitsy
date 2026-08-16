// Command string to structured op (BUILD-PLAN section 2).
// Act 1 grammar only. Error text is real-git-shaped: it is teaching material.

export type ParsedCommand =
  | { cmd: 'init' }
  | { cmd: 'add'; paths: string[]; all: boolean; patch: boolean }
  | { cmd: 'commit'; messages: string[]; allowEmpty: boolean }
  | { cmd: 'status'; short: boolean; showBranch: boolean }
  | { cmd: 'log'; oneline: boolean; maxCount: number | null }
  | { cmd: 'diff'; staged: boolean; paths: string[] }
  | { cmd: 'restore'; paths: string[]; staged: boolean; worktree: boolean }
  | { cmd: 'branch'; name: string | null; deleteName: string | null }
  | { cmd: 'switch'; name: string; create: boolean }
  | { cmd: 'checkout'; name: string; create: boolean }
  | { cmd: 'merge'; branch: string }
  | { cmd: 'tag'; name: string }
  | { cmd: 'reset'; mode: 'soft' | 'mixed' | 'hard'; target: string | null }
  | { cmd: 'remote'; verbose: boolean }
  | { cmd: 'fetch'; remote: string }
  | { cmd: 'pull'; remote: string }
  | {
      cmd: 'push';
      remote: string;
      branch: string | null;
      force: boolean;
      forceWithLease: boolean;
      setUpstream: boolean;
    }
  | { cmd: 'clone' }
  | { cmd: 'unsupported'; name: string; args: string[] };

export type ParseResult =
  | { ok: true; command: ParsedCommand }
  | { ok: false; stderr: string };

// Real git commands Gitsy does not teach yet. The terminal gate (Phase 3)
// turns these into the in-fiction "not yet unlocked" message.
const LATER_COMMANDS = new Set([
  'revert', 'cherry-pick', 'rebase', 'stash',
  'reflog', 'bisect', 'blame', 'worktree', 'show', 'rm', 'mv', 'config',
]);

const USAGE: Record<string, string> = {
  init: 'usage: git init [<directory>]',
  add: 'usage: git add [<options>] [--] <pathspec>...',
  commit: 'usage: git commit [<options>] [--] <pathspec>...',
  status: 'usage: git status [<options>] [--] [<pathspec>...]',
  log: 'usage: git log [<options>] [<revision-range>]',
  diff: 'usage: git diff [<options>] [--] [<path>...]',
  restore: 'usage: git restore [<options>] [--] <file>...',
  branch: 'usage: git branch [<options>] [<branch-name>]',
  switch: 'usage: git switch [<options>] <branch>',
  checkout: 'usage: git checkout [<options>] <branch>',
  merge: 'usage: git merge [<options>] <branch>',
  tag: 'usage: git tag [<options>] <tag-name>',
  reset: 'usage: git reset [--soft | --mixed | --hard] [<commit>]',
  remote: 'usage: git remote [-v | --verbose]',
  fetch: 'usage: git fetch [<remote>]',
  pull: 'usage: git pull [<remote>]',
  push: 'usage: git push [-u | --set-upstream] [--force | --force-with-lease] [<remote>] [<branch>]',
};

/** Shell-ish tokenizer: whitespace splits, single and double quotes group.
 *  Returns null on an unterminated quote. */
export function tokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (const ch of input) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current.length > 0) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += ch;
    }
  }
  if (quote !== null) return null;
  if (started || current.length > 0) tokens.push(current);
  return tokens;
}

const err = (stderr: string): ParseResult => ({ ok: false, stderr });

function unknownOption(name: string, flag: string): ParseResult {
  return err(`error: unknown option '${flag.replace(/^-+/, '')}'\n${USAGE[name]}`);
}

export function parseCommand(input: string): ParseResult {
  const tokens = tokenize(input);
  if (tokens === null) return err('error: unterminated quote');
  if (tokens.length === 0) return err('usage: git <command> [<options>]');

  const args = tokens[0] === 'git' ? tokens.slice(1) : tokens;
  if (args.length === 0) return err('usage: git <command> [<options>]');

  const name = args[0];
  const rest = args.slice(1);

  if (LATER_COMMANDS.has(name)) {
    return { ok: true, command: { cmd: 'unsupported', name, args: rest } };
  }

  switch (name) {
    case 'init': {
      const flag = rest.find((t) => t.startsWith('-'));
      if (flag) return unknownOption('init', flag);
      return { ok: true, command: { cmd: 'init' } };
    }

    case 'add': {
      const paths: string[] = [];
      let all = false;
      let patch = false;
      for (const t of rest) {
        if (t === '-A' || t === '--all') all = true;
        else if (t === '-p' || t === '--patch') patch = true;
        else if (t === '--') continue;
        else if (t.startsWith('-')) return unknownOption('add', t);
        else paths.push(t);
      }
      if (paths.includes('.')) all = true; // `git add .` stages everything below cwd
      return { ok: true, command: { cmd: 'add', paths, all, patch } };
    }

    case 'commit': {
      const messages: string[] = [];
      let allowEmpty = false;
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        if (t === '-m' || t === '--message') {
          const value = rest[++i];
          if (value === undefined) {
            return err('error: option `message` requires a value\n' + USAGE.commit);
          }
          messages.push(value);
        } else if (t.startsWith('-m') && t.length > 2) {
          messages.push(t.slice(2));
        } else if (t.startsWith('--message=')) {
          messages.push(t.slice('--message='.length));
        } else if (t === '--allow-empty') {
          allowEmpty = true;
        } else if (t === '--') {
          continue;
        } else if (t.startsWith('-')) {
          return unknownOption('commit', t);
        }
        // bare pathspecs on commit are an Act 4+ nuance; ignored for now
      }
      return { ok: true, command: { cmd: 'commit', messages, allowEmpty } };
    }

    case 'status': {
      let short = false;
      let showBranch = false;
      for (const t of rest) {
        // Combined one-letter flags are real git usage: -sb === -s -b.
        const combined = /^-([sb]+)$/.exec(t);
        if (t === '-s' || t === '--short') short = true;
        else if (t === '-b' || t === '--branch') showBranch = true;
        else if (combined) {
          if (combined[1].includes('s')) short = true;
          if (combined[1].includes('b')) showBranch = true;
        } else if (t === '--') continue;
        else if (t.startsWith('-')) return unknownOption('status', t);
      }
      return { ok: true, command: { cmd: 'status', short, showBranch } };
    }

    case 'log': {
      let oneline = false;
      let maxCount: number | null = null;
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        if (t === '--oneline') {
          oneline = true;
        } else if (t === '-n' || t === '--max-count') {
          const value = rest[++i];
          const n = Number(value);
          if (value === undefined || !Number.isInteger(n) || n < 1) {
            return err('error: option `max-count` requires a number\n' + USAGE.log);
          }
          maxCount = n;
        } else if (t.startsWith('--max-count=')) {
          const n = Number(t.slice('--max-count='.length));
          if (!Number.isInteger(n) || n < 1) {
            return err('error: option `max-count` requires a number\n' + USAGE.log);
          }
          maxCount = n;
        } else if (/^-\d+$/.test(t)) {
          maxCount = Number(t.slice(1));
        } else if (t.startsWith('-')) {
          return unknownOption('log', t);
        }
      }
      return { ok: true, command: { cmd: 'log', oneline, maxCount } };
    }

    case 'diff': {
      let staged = false;
      const paths: string[] = [];
      for (const t of rest) {
        if (t === '--cached' || t === '--staged') staged = true;
        else if (t === '--') continue;
        else if (t.startsWith('-')) return unknownOption('diff', t);
        else paths.push(t);
      }
      return { ok: true, command: { cmd: 'diff', staged, paths } };
    }

    case 'restore': {
      let staged = false;
      let worktree = false;
      const paths: string[] = [];
      for (const t of rest) {
        if (t === '--staged' || t === '-S') staged = true;
        else if (t === '--worktree' || t === '-W') worktree = true;
        else if (t === '--') continue;
        else if (t.startsWith('-')) return unknownOption('restore', t);
        else paths.push(t);
      }
      if (paths.length === 0) return err('fatal: you must specify path(s) to restore');
      if (!staged) worktree = true; // real default: worktree only
      return { ok: true, command: { cmd: 'restore', paths, staged, worktree } };
    }

    case 'branch': {
      let deleteName: string | null = null;
      let name: string | null = null;
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        if (t === '-d' || t === '-D' || t === '--delete') {
          const value = rest[++i];
          if (value === undefined) return err('fatal: branch name required\n' + USAGE.branch);
          deleteName = value;
        } else if (t.startsWith('-')) {
          return unknownOption('branch', t);
        } else {
          name = t;
        }
      }
      return { ok: true, command: { cmd: 'branch', name, deleteName } };
    }

    case 'switch':
    case 'checkout': {
      const verb = name as 'switch' | 'checkout'; // loop below shadows `name`
      let create = false;
      let branchName: string | null = null;
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        if (t === '-c' || t === '-b') {
          const value = rest[++i];
          if (value === undefined) return err(`fatal: missing branch name\n${USAGE[verb]}`);
          branchName = value;
          create = true;
        } else if (t === '--') {
          continue;
        } else if (t.startsWith('-')) {
          return unknownOption(verb, t);
        } else {
          branchName = t;
        }
      }
      if (!branchName) return err(`fatal: missing branch name\n${USAGE[verb]}`);
      return { ok: true, command: { cmd: verb, name: branchName, create } };
    }

    case 'merge': {
      let branch: string | null = null;
      for (const t of rest) {
        if (t === '--') continue;
        else if (t.startsWith('-')) return unknownOption('merge', t);
        else branch = t;
      }
      if (!branch) return err('fatal: no branch specified\n' + USAGE.merge);
      return { ok: true, command: { cmd: 'merge', branch } };
    }

    case 'tag': {
      let name: string | null = null;
      for (const t of rest) {
        if (t.startsWith('-')) return unknownOption('tag', t);
        name = t;
      }
      if (!name) return err('fatal: tag name required\n' + USAGE.tag);
      return { ok: true, command: { cmd: 'tag', name } };
    }

    case 'reset': {
      // Act 4 lands the mode-flags subset early (Phase 5 gate): resetting
      // PATHS stays unsupported; `git restore --staged` covers that lesson.
      let mode: 'soft' | 'mixed' | 'hard' = 'mixed'; // real git's default
      let target: string | null = null;
      for (const t of rest) {
        if (t === '--soft' || t === '--mixed' || t === '--hard') {
          mode = t.slice(2) as 'soft' | 'mixed' | 'hard';
        } else if (t === '--') {
          continue;
        } else if (t.startsWith('-')) {
          return unknownOption('reset', t);
        } else if (target === null) {
          target = t;
        } else {
          return err(
            'fatal: resetting paths is not supported in Gitsy\n' +
              'hint: to unstage a file, use git restore --staged <file>\n' +
              USAGE.reset,
          );
        }
      }
      return { ok: true, command: { cmd: 'reset', mode, target } };
    }

    case 'remote': {
      let verbose = false;
      for (const t of rest) {
        if (t === '-v' || t === '--verbose') verbose = true;
        else return unknownOption('remote', t);
      }
      return { ok: true, command: { cmd: 'remote', verbose } };
    }

    case 'fetch': {
      let remote: string | null = null;
      for (const t of rest) {
        if (t === '--') continue;
        else if (t.startsWith('-')) return unknownOption('fetch', t);
        else if (remote === null) remote = t;
        else return err('fatal: Gitsy fetch always fetches every branch\n' + USAGE.fetch);
      }
      return { ok: true, command: { cmd: 'fetch', remote: remote ?? 'origin' } };
    }

    case 'pull': {
      let remote: string | null = null;
      for (const t of rest) {
        if (t === '--') continue;
        else if (t.startsWith('-')) return unknownOption('pull', t);
        else if (remote === null) remote = t;
        else return err('fatal: Gitsy pull always pulls the current branch\n' + USAGE.pull);
      }
      return { ok: true, command: { cmd: 'pull', remote: remote ?? 'origin' } };
    }

    case 'push': {
      let remote: string | null = null;
      let branch: string | null = null;
      let force = false;
      let forceWithLease = false;
      let setUpstream = false;
      for (const t of rest) {
        if (t === '-f' || t === '--force') force = true;
        else if (t === '--force-with-lease') forceWithLease = true;
        else if (t === '-u' || t === '--set-upstream') setUpstream = true;
        else if (t === '--') continue;
        else if (t.startsWith('-')) return unknownOption('push', t);
        else if (remote === null) remote = t;
        else if (branch === null) branch = t;
        else return err('fatal: Gitsy push takes at most <remote> <branch>\n' + USAGE.push);
      }
      return {
        ok: true,
        command: { cmd: 'push', remote: remote ?? 'origin', branch, force, forceWithLease, setUpstream },
      };
    }

    case 'clone': {
      // Parsed so the executor can answer in-fiction; `clone` never sits in
      // a level's unlocked list, and ACT_OF no longer locks it: the fiction
      // message is the teaching everywhere.
      return { ok: true, command: { cmd: 'clone' } };
    }

    default:
      return err(`git: '${name}' is not a git command. See 'git --help'.`);
  }
}
