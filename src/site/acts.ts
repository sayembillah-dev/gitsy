// The five-act curriculum arc (BUILD-PLAN section 7). Acts whose levels do
// not exist yet render locked; acts with levels link straight into play.

export interface ActInfo {
  n: 1 | 2 | 3 | 4 | 5;
  name: string;
  cliff: string;
  commands: string[];
}

export const ACTS: ActInfo[] = [
  {
    n: 1,
    name: 'Three trees',
    cliff: 'A commit is a snapshot, not a diff',
    commands: ['init', 'add', 'commit', 'status', 'diff', 'restore', 'log', 'add -p'],
  },
  {
    n: 2,
    name: 'The graph',
    cliff: 'A branch is a pointer, not a container',
    commands: ['branch', 'switch', 'merge', 'tag'],
  },
  {
    n: 3,
    name: 'Distributed',
    cliff: 'origin/main is a local cache',
    commands: ['remote', 'fetch', 'push', 'pull', '--force-with-lease'],
  },
  {
    n: 4,
    name: 'Rewriting',
    cliff: 'Rebase copies; it does not move',
    commands: ['amend', 'reset', 'revert', 'cherry-pick', 'rebase -i', 'stash'],
  },
  {
    n: 5,
    name: 'Recovery',
    cliff: 'The object store is append-only',
    commands: ['reflog', 'bisect', 'blame', 'worktree', 'log -S'],
  },
];
