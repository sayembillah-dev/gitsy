// The predicate registry (BUILD-PLAN section 5). Every goal, constraint, and
// diagnostic in a level file names one of these. Pure functions over a
// RepoSnapshot: no git calls, no I/O, no platform APIs.
//
// Ref arguments ("ref") accept a branch name, tag name, remote branch name,
// the literal "HEAD", or a raw structural hash.

import type { GameCommit, Predicate, RepoSnapshot, StructHash } from './types';

export interface PredicateEntry {
  fn: Predicate;
  /** When true, evaluate() appends the EvalEnv command count as the final arg. */
  needsEnv?: boolean;
  /** One line of documentation, surfaced in tooling and hint copy later. */
  summary: string;
}

/** Commits visible to predicates: local objects plus the remote's objects. */
function commitMap(snap: RepoSnapshot): Record<StructHash, GameCommit> {
  return snap.remote ? { ...snap.remote.commits, ...snap.commits } : snap.commits;
}

function headHash(snap: RepoSnapshot): StructHash | null {
  if (snap.head.type === 'detached') return snap.head.at;
  return snap.branches[snap.head.name] ?? null;
}

/** Resolves a ref-ish string to a structural hash, or null when unknown. */
export function resolveRefish(snap: RepoSnapshot, ref: unknown): StructHash | null {
  if (typeof ref !== 'string' || ref.length === 0) return null;
  if (ref === 'HEAD') return headHash(snap);
  if (ref in snap.branches) return snap.branches[ref];
  if (ref in snap.tags) return snap.tags[ref];
  if (ref in snap.remoteBranches) return snap.remoteBranches[ref];
  const asHash = ref as StructHash;
  return asHash in commitMap(snap) ? asHash : null;
}

/** Every commit reachable from `start`, parents-first walk, `start` included. */
export function reachableFrom(snap: RepoSnapshot, start: StructHash): Set<StructHash> {
  const commits = commitMap(snap);
  const seen = new Set<StructHash>();
  const stack: StructHash[] = [start];
  while (stack.length > 0) {
    const hash = stack.pop() as StructHash;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const commit = commits[hash];
    if (!commit) continue; // dangling parent: keep the node, stop the walk
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

export const predicateRegistry: Record<string, PredicateEntry> = {
  refExists: {
    fn: (snap, name) =>
      typeof name === 'string' &&
      (name in snap.branches || name in snap.tags || name in snap.remoteBranches),
    summary: 'A branch, tag, or remote-tracking ref with this name exists.',
  },

  headIsOn: {
    fn: (snap, branch) => snap.head.type === 'branch' && snap.head.name === branch,
    summary: 'HEAD points at the given branch.',
  },

  detachedHead: {
    fn: (snap) => snap.head.type === 'detached',
    summary: 'HEAD points directly at a commit, not a branch.',
  },

  commitCount: {
    fn: (snap, ref, n) => {
      const start = resolveRefish(snap, ref);
      return start !== null && reachableFrom(snap, start).size === n;
    },
    summary: 'Exactly n commits are reachable from ref.',
  },

  commitReachable: {
    fn: (snap, ref, message) => {
      const start = resolveRefish(snap, ref);
      if (start === null) return false;
      const commits = commitMap(snap);
      for (const hash of reachableFrom(snap, start)) {
        if (commits[hash]?.message === message) return true;
      }
      return false;
    },
    summary: 'A commit whose message equals the given one is reachable from ref.',
  },

  isAncestor: {
    // Matches `git merge-base --is-ancestor`: equality counts as ancestor.
    fn: (snap, a, b) => {
      const ha = resolveRefish(snap, a);
      const hb = resolveRefish(snap, b);
      return ha !== null && hb !== null && reachableFrom(snap, hb).has(ha);
    },
    summary: 'Commit a is an ancestor of (or equal to) commit b.',
  },

  noMergeCommits: {
    fn: (snap, ref) => {
      const start = resolveRefish(snap, ref);
      if (start === null) return false;
      const commits = commitMap(snap);
      for (const hash of reachableFrom(snap, start)) {
        if ((commits[hash]?.parents.length ?? 0) > 1) return false;
      }
      return true;
    },
    summary: 'No commit reachable from ref has more than one parent.',
  },

  isLinear: {
    // For parent-walk reachability this coincides with noMergeCommits today.
    // Kept as its own key because level copy says "linear", and Act 4 may
    // tighten it (first-parent chain) without rewriting level JSON.
    fn: (snap, ref) => {
      const start = resolveRefish(snap, ref);
      if (start === null) return false;
      const commits = commitMap(snap);
      let roots = 0;
      for (const hash of reachableFrom(snap, start)) {
        const commit = commits[hash];
        if (!commit) return false;
        if (commit.parents.length > 1) return false;
        if (commit.parents.length === 0) roots += 1;
      }
      return roots === 1;
    },
    summary: 'History reachable from ref is one straight chain with a single root.',
  },

  workingTreeClean: {
    // Mirrors `git status` "nothing to commit, working tree clean": both the
    // workdir-vs-index side and the index-vs-HEAD side must be clean, so a
    // staged-but-uncommitted change does NOT count as clean.
    fn: (snap) =>
      snap.workingTree.every((f) => f.status === 'clean') &&
      snap.index.every((f) => f.status === 'clean'),
    summary: 'git status would say "nothing to commit, working tree clean".',
  },

  fileStaged: {
    fn: (snap, path) => snap.index.some((f) => f.path === path && f.status === 'staged'),
    summary: 'The index version of path differs from HEAD (X column of status).',
  },

  fileModified: {
    fn: (snap, path) =>
      snap.workingTree.some((f) => f.path === path && f.status === 'modified'),
    summary: 'The workdir version of path differs from the index (Y column of status).',
  },

  hasConflict: {
    fn: (snap) =>
      [...snap.workingTree, ...snap.index].some((f) => f.status === 'conflicted'),
    summary: 'Any file carries conflict markers from an unresolved merge.',
  },

  tagExists: {
    fn: (snap, name) => typeof name === 'string' && name in snap.tags,
    summary: 'A tag with this name exists.',
  },

  stashCount: {
    fn: (snap, n) => snap.stash.length === n,
    summary: 'Exactly n entries sit on the stash.',
  },

  maxCommands: {
    fn: (_snap, n, ran) => typeof ran === 'number' && ran <= (n as number),
    needsEnv: true,
    summary: 'The player has run at most n commands. Constraint-only.',
  },

  remoteAhead: {
    fn: (snap, branch) => {
      if (!snap.remote || typeof branch !== 'string') return false;
      const remoteTip = snap.remote.branches[branch] ?? snap.remoteBranches[branch];
      if (!remoteTip) return false;
      const localTip = snap.branches[branch];
      if (!localTip) return true; // remote has the branch, local does not
      return !reachableFrom(snap, localTip).has(remoteTip);
    },
    summary: 'The remote copy of branch has commits the local branch lacks.',
  },

  trackingSet: {
    fn: (snap, branch) => typeof branch === 'string' && branch in snap.remoteBranches,
    summary: 'A remote-tracking ref (origin/branch) exists locally.',
  },

  remoteSynced: {
    // Structural hashes are content-addressed, so a push that copied objects
    // leaves both sides pointing at the SAME StructHash.
    fn: (snap, branch) => {
      if (!snap.remote || typeof branch !== 'string') return false;
      const localTip = snap.branches[branch];
      const remoteTip = snap.remote.branches[branch];
      return localTip !== undefined && remoteTip !== undefined && localTip === remoteTip;
    },
    summary: 'Local branch tip and the remote branch tip are the same commit.',
  },

  stillReachable: {
    // The revert-over-reset teacher: a commit "survives" if any ref, HEAD,
    // stash entry, or reflog entry can still walk to it.
    fn: (snap, hash) => {
      if (typeof hash !== 'string') return false;
      const target = hash as StructHash;
      if (!(target in commitMap(snap))) return false;
      const tips: StructHash[] = [
        ...Object.values(snap.branches),
        ...Object.values(snap.tags),
        ...Object.values(snap.remoteBranches),
        ...snap.stash.map((s) => s.hash),
        ...snap.reflog.map((r) => r.hash),
      ];
      const head = headHash(snap);
      if (head) tips.push(head);
      return tips.some((tip) => reachableFrom(snap, tip).has(target));
    },
    summary: 'The commit is still reachable from some ref, stash, or reflog entry.',
  },
};

export function getPredicate(name: string): PredicateEntry | undefined {
  return predicateRegistry[name];
}
