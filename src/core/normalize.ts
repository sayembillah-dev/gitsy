import { sha256Hex } from './sha256';
import type {
  FileEntry,
  GameCommit,
  HeadState,
  RepoSnapshot,
  StructHash,
} from './types';

/** A commit exactly as read from the object store, before normalization. */
export interface RawCommit {
  sha: string;
  message: string;
  parents: string[]; // git SHAs
  tree: Record<string, string>; // path to content
}

/**
 * Plain-data view of a repository. Produced by the engine layer (src/engine),
 * which owns every isomorphic-git call. Core never touches git directly.
 */
export interface RawRepo {
  commits: RawCommit[];
  branches: Record<string, string>; // name to git SHA
  tags: Record<string, string>;
  remoteBranches: Record<string, string>;
  head: { type: 'branch'; name: string } | { type: 'detached'; sha: string };
  workingTree: FileEntry[];
  index: FileEntry[];
  /** Stash stack entries (newest first), from the engine journal (Act 4). */
  stash: { sha: string; message: string }[];
  /** Reflog entries (newest first), from the engine journal (Act 5). */
  reflog: { sha: string; label: string }[];
  /** Linked worktrees, from the engine journal (Act 5). */
  worktrees: { path: string; branch: string }[];
}

/**
 * structHash(commit) per BUILD-PLAN section 3. Author, committer, and
 * timestamps are deliberately excluded: two players who solve a level
 * identically produce identical structural hashes and different git SHAs.
 */
export function structHashOf(
  message: string,
  parents: StructHash[],
  tree: Record<string, string>,
): StructHash {
  const payload =
    message +
    '\0' +
    [...parents].sort().join(',') +
    '\0' +
    Object.entries(tree)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => path + ':' + sha256Hex(content))
      .join(',');
  return sha256Hex(payload) as StructHash;
}

const stripTrailingNewlines = (message: string): string => message.replace(/\n+$/, '');

export function normalizeRepo(raw: RawRepo): RepoSnapshot {
  const bySha = new Map(raw.commits.map((c) => [c.sha, c]));
  const memo = new Map<string, StructHash>();

  const hashOf = (sha: string): StructHash => {
    const cached = memo.get(sha);
    if (cached) return cached;
    const commit = bySha.get(sha);
    if (!commit) throw new Error(`normalize: missing commit object for sha ${sha}`);
    const hash = structHashOf(
      stripTrailingNewlines(commit.message),
      commit.parents.map(hashOf),
      commit.tree,
    );
    memo.set(sha, hash);
    return hash;
  };

  const commits: Record<StructHash, GameCommit> = {};
  for (const commit of raw.commits) {
    const hash = hashOf(commit.sha);
    commits[hash] = {
      hash,
      sha: commit.sha,
      message: stripTrailingNewlines(commit.message),
      parents: commit.parents.map(hashOf),
      tree: commit.tree,
      lane: 0, // renderer assigns lanes (Phase 4)
    };
  }

  const mapRefs = (refs: Record<string, string>): Record<string, StructHash> =>
    Object.fromEntries(Object.entries(refs).map(([name, sha]) => [name, hashOf(sha)]));

  const head: HeadState =
    raw.head.type === 'branch'
      ? { type: 'branch', name: raw.head.name }
      : { type: 'detached', at: hashOf(raw.head.sha) };

  // Journal-backed fields (Phase 10). Entries whose commit did not survive
  // into the walk are skipped defensively; readState normally guarantees
  // their presence by adding them to the walk tips.
  const stash = raw.stash
    .filter((s) => bySha.has(s.sha))
    .map((s) => ({ message: s.message, hash: hashOf(s.sha) }));
  const reflog = raw.reflog
    .filter((r) => bySha.has(r.sha))
    .map((r) => ({ hash: hashOf(r.sha), label: r.label }));

  return {
    commits,
    branches: mapRefs(raw.branches),
    tags: mapRefs(raw.tags),
    remoteBranches: mapRefs(raw.remoteBranches),
    head,
    workingTree: raw.workingTree,
    index: raw.index,
    stash,
    reflog,
    worktrees: raw.worktrees,
  };
}
