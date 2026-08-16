// src/core/types.ts
//
// THE CONTRACT (BUILD-PLAN §0, rule 1). Written once, deliberately, frozen.
// Never regenerate. If a change is genuinely needed, edit by hand and note
// why in DECISIONS.md.

/** Content-and-position identity for a commit. NOT a git SHA. */
export type StructHash = string & { readonly __brand: 'StructHash' };

export type FileStatus =
  | 'clean' | 'untracked' | 'modified' | 'staged'
  | 'deleted' | 'conflicted';

export interface FileEntry {
  path: string;
  status: FileStatus;
  content: string;
}

export interface GameCommit {
  hash: StructHash;
  sha: string;              // real git SHA — display only, never compared
  message: string;
  parents: StructHash[];
  tree: Record<string, string>;   // path → content
  lane: number;             // renderer hint, assigned by layout
}

export type HeadState =
  | { type: 'branch'; name: string }
  | { type: 'detached'; at: StructHash };

export interface RepoSnapshot {
  commits: Record<StructHash, GameCommit>;
  branches: Record<string, StructHash>;
  tags: Record<string, StructHash>;
  remoteBranches: Record<string, StructHash>;   // "origin/main" → hash
  head: HeadState;
  workingTree: FileEntry[];
  index: FileEntry[];
  stash: { message: string; hash: StructHash }[];
  reflog: { hash: StructHash; label: string }[];
  /** Present from Act 3 onward. The simulated remote, same shape. */
  remote?: Omit<RepoSnapshot, 'remote'>;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;           // real git error text — this is teaching material
  snapshot: RepoSnapshot;
}

// ---- Levels -------------------------------------------------------------

export type SetupOp =
  | { op: 'commit'; message: string; files: Record<string, string> }
  | { op: 'branch'; name: string }
  | { op: 'checkout'; ref: string }
  | { op: 'write'; path: string; content: string }
  | { op: 'stage'; path: string }
  | { op: 'tag'; name: string }
  | { op: 'remotePush'; branch: string }
  | { op: 'remoteCommit'; message: string; files: Record<string, string> };

export interface Assertion {
  assert: string;           // key into the predicate registry
  args?: unknown[];
  label: string;            // shown in the goal checklist
}

export interface Diagnostic {
  when: string;             // predicate key — fires when TRUE
  args?: unknown[];
  say: string;
}

export interface LevelDef {
  id: string;
  act: 1 | 2 | 3 | 4 | 5;
  title: string;
  brief: string;            // markdown, shown before play
  setup: SetupOp[];
  unlocked: string[];       // e.g. ["git add", "git commit", "git status"]
  goals: Assertion[];
  constraints?: Assertion[];  // e.g. maxCommands
  diagnostics?: Diagnostic[];
  hints: string[];            // fallback ladder, escalating
  par?: number;
}

export interface EvaluationResult {
  goals: { label: string; passed: boolean }[];
  constraintsViolated: string[];
  complete: boolean;
  diagnostic?: string;
}

// ---- Engine boundary ----------------------------------------------------

export interface GitEngine {
  buildLevel(setup: SetupOp[]): Promise<RepoSnapshot>;
  run(command: string): Promise<CommandResult>;
  snapshot(): Promise<RepoSnapshot>;
}

export type Predicate = (snap: RepoSnapshot, ...args: any[]) => boolean;
