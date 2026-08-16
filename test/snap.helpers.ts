// Hand-built RepoSnapshot factories for core unit tests. Pure data, no
// engine: predicates and evaluate never touch git, so neither do these.

import { structHashOf } from '@/core/normalize';
import type { FileEntry, FileStatus, GameCommit, RepoSnapshot, StructHash } from '@/core/types';

let shaCounter = 0;

export function makeCommit(
  message: string,
  parents: StructHash[] = [],
  tree: Record<string, string> = {},
): GameCommit {
  const hash = structHashOf(message, parents, tree);
  shaCounter += 1;
  return { hash, sha: `testsha${shaCounter}`, message, parents, tree, lane: 0 };
}

export function file(path: string, status: FileStatus, content = ''): FileEntry {
  return { path, status, content };
}

export function makeSnap(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    commits: {},
    branches: {},
    tags: {},
    remoteBranches: {},
    head: { type: 'branch', name: 'main' },
    workingTree: [],
    index: [],
    stash: [],
    reflog: [],
    ...overrides,
  };
}

const byHash = (list: GameCommit[]): Record<StructHash, GameCommit> =>
  Object.fromEntries(list.map((c) => [c.hash, c]));

/** c1 -> c2 -> c3, a straight line on main. */
export function chainGraph() {
  const c1 = makeCommit('root', [], { 'a.txt': 'one\n' });
  const c2 = makeCommit('second', [c1.hash], { 'a.txt': 'two\n' });
  const c3 = makeCommit('third', [c2.hash], { 'a.txt': 'three\n' });
  return { c1, c2, c3, commits: byHash([c1, c2, c3]) };
}

/** root forks into mainline and side, then merge joins them. */
export function mergeGraph() {
  const root = makeCommit('root', [], { 'a.txt': 'one\n' });
  const mainline = makeCommit('main work', [root.hash], { 'a.txt': 'two\n' });
  const side = makeCommit('feature work', [root.hash], { 'b.txt': 'bee\n' });
  const merge = makeCommit('merge feature', [mainline.hash, side.hash], {
    'a.txt': 'two\n',
    'b.txt': 'bee\n',
  });
  return { root, mainline, side, merge, commits: byHash([root, mainline, side, merge]) };
}
