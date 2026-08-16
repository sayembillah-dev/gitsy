# Git Learning Game — Build Plan & Implementation Spec

A browser game that takes a total beginner to Git expert. Next.js, no separate backend,
2D SVG, real Git engine, real terminal.

This document is written to be **fed to a coding agent**. Sections 1–4 are contracts:
they do not change once written. Sections 5+ are the build order.

---

## 0. The vibecoding strategy

Read this first. It matters more than any technical choice below.

Large AI-built projects fail in a specific way: session 3 invents a slightly different
shape for a thing session 1 already defined, nothing type-errors immediately, and by
session 9 there are three incompatible notions of "repo state." The countermeasures:

**1. Types are law.** `src/core/types.ts` is written once, deliberately, and is
**never regenerated**. Every prompt from then on begins by pasting it in. If a phase
genuinely needs a type change, you edit it by hand and note why in `DECISIONS.md`.

**2. Headless before visual.** Phases 1 and 2 have no UI at all. They are pure
TypeScript with Vitest tests. Most projects like this build a pretty graph first and
discover in month two that the underlying model can't express what levels need. You
will know your model is correct before you draw a single pixel.

**3. Phase gates.** Each phase below ends with an explicit acceptance test. Do not start
phase N+1 until phase N's gate passes. Tell the agent the gate up front — it changes
what it writes.

**4. One file per prompt.** "Implement `src/core/predicates.ts` per the contract below"
beats "build the predicate system." Long multi-file generations are where drift enters.

**5. Keep `AGENTS.md` at repo root.** Short, blunt invariants the agent re-reads every
session. Draft in §9.

**6. Commit at every gate.** You are learning Git by building a Git game — use branches
per phase. If a phase goes sideways, you throw away a branch, not a week.

---

## 1. Architecture

```
Browser
├── Main thread
│   ├── Next.js site layer      static pages, SEO, docs, level catalog
│   └── Game island             'use client', ssr:false
│       ├── Terminal            xterm.js — real command strings
│       ├── Renderer            SVG: graph + three-trees panels
│       └── Level shell         checklist, hints, undo, progress
└── Worker
    ├── isomorphic-git + lightning-fs (IndexedDB)
    ├── Command parser & executor
    └── Snapshot normalizer     strips SHAs → structural model
```

**Why the worker.** Git operations on a real object store are synchronous CPU work.
On the main thread they stutter the render loop at exactly the moment the animation
matters. Retrofitting a worker boundary later forces every call async and serializable —
painful. Do it on day one.

**Nothing but plain JSON crosses the worker boundary.** No class instances, no functions,
no `Map`/`Set`. Use Comlink for ergonomics but keep the payloads dumb.

**Persistence stores the command log, never repo bytes.** `setup + commands[0..n]`
deterministically rebuilds any state. That one decision gives you undo, level reset,
shareable solution URLs, replay animation, and failure analytics for free.

---

## 2. Repo structure

```
/app
  /(site)                    server-rendered marketing & docs
    page.tsx
    /levels/[slug]/page.tsx  per-level explainer — SEO surface
  /play/[levelId]/page.tsx   thin wrapper, dynamic-imports the island
  /api/telemetry/route.ts
/src
  /core                      PURE. no React, no DOM, no browser APIs.
    types.ts                 ← the contract. never regenerate.
    normalize.ts             raw git state → RepoSnapshot
    predicates.ts            assertion library
    evaluate.ts              runs goals + diagnostics against a snapshot
    levelSchema.ts           zod schema for level JSON
  /engine
    git.worker.ts            worker entry
    engineClient.ts          main-thread proxy (Comlink)
    parser.ts                command string → structured op
    executor.ts              structured op → isomorphic-git calls
  /game
    GameShell.tsx            the island root
    /terminal
    /graph                   SVG DAG renderer
    /trees                   working tree / index / objects panels
    /hud                     checklist, hints, command budget
    store.ts                 zustand
  /content
    /levels/*.json           curriculum as data
    icons.ts                 Phosphor sprite manifest
/test
  levels.spec.ts             every level's canonical solution must pass
```

The `/src/core` purity rule is load-bearing. It stays testable in Node with zero mocking,
and it is the part the agent must never contaminate with React.

---

## 3. The type contract

Write this file first, by hand or in one dedicated session. Review every line. Then
freeze it.

```ts
// src/core/types.ts

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
```

### The normalization rule

```
structHash(commit) = sha256(
  commit.message + '\0' +
  sorted(parents.map(structHash)).join(',') + '\0' +
  sorted(Object.entries(tree)).map(([p, c]) => p + ':' + sha256(c)).join(',')
)
```

Author, committer, and timestamps are **deliberately excluded**. Two players who solve a
level identically produce identical structural hashes and completely different git SHAs.
Everything downstream compares structural hashes; git SHAs are display-only.

### Determinism rule

Every commit created during `buildLevel` uses a fixed author and a fixed, monotonically
incrementing timestamp:

```ts
const AUTHOR = { name: 'Level Builder', email: 'level@game.local' };
const t0 = 1700000000; // seconds
// nth setup commit → timestamp t0 + n * 60
```

Without this, level SHAs differ per run and shareable URLs, snapshot tests, and OG image
generation all break.

---

## 4. Design tokens

Direction: **drafting table, not arcade.** The subject's world is plumbing, object
stores, and directed graphs — the visual language is technical drawing. Blueprint ground,
hairline rules, monospace as a co-lead typeface rather than a code-only ghetto, and colour
reserved *entirely* for file state. Nothing is coloured for decoration; if something is
coloured, it means something.

```css
--ground:      #101A2B;   /* blueprint indigo — the canvas */
--panel:       #16233A;
--rule:        #2A3B57;   /* hairlines, 0.5px */
--ink:         #DCE6F5;
--ink-dim:     #7E93B5;

/* state colours — the ONLY use of hue in the app */
--st-clean:    #7E93B5;
--st-modified: #E0A94B;   /* brass */
--st-staged:   #5BD6A0;   /* jade */
--st-conflict: #E8664F;   /* vermilion */
--st-head:     #8FB8FF;   /* HEAD marker, tracking refs */
--st-ghost:    #4A5C79;   /* abandoned / unreachable commits */
```

Type: `JetBrains Mono` for terminal, commit messages, refs, and all data. A technical
grotesque (`Inter Tight` or similar) for prose and UI chrome only. The monospace is the
protagonist — this is a tool, and it should look like one.

**Signature element:** the commit graph rendered as a *drafting object* — lane rails with
tick marks, refs as dimension labels on leader lines, abandoned commits fading to
`--st-ghost` rather than disappearing. The rebase animation is the thing people will
screenshot; spend your polish budget there and keep everything else quiet.

Icons: `@phosphor-icons/core` raw SVG, built into a `<symbol>` sprite at build time,
referenced with `<use href="#i-git-commit">`. Never the React package inside the canvas —
you want one SVG coordinate space, not scattered DOM. Weight tracks progression:
`duotone`/`bold` in Acts 1–2, `light` in Acts 4–5.

---

## 5. Build phases

Each phase ends with a gate. Do not proceed until it passes.

### Phase 0 — Scaffold
Next.js (App Router) + TypeScript strict + Vitest + Tailwind + zustand. Tokens as CSS
vars. `AGENTS.md` at root. Empty `/play/[levelId]` route that dynamic-imports a stub
island with `ssr: false`.

**Gate:** `next build` succeeds; `/play/test` renders "island mounted" with no
hydration warnings.

### Phase 1 — Engine (headless)
`git.worker.ts`, `parser.ts`, `executor.ts`, `normalize.ts`. Support only Act 1 commands
initially: `init add commit status log diff restore`. Parser returns structured ops;
unknown flags produce real-git-shaped error text.

**Gate:** a Vitest suite runs `buildLevel` then a command sequence and asserts on the
returned `RepoSnapshot`. Zero React imported anywhere in `/src/core`. Same setup run
twice yields identical structural hashes.

### Phase 2 — Predicates & evaluation
`predicates.ts` registry, `evaluate.ts`, `levelSchema.ts` (zod). Ship this predicate set:

```
refExists(name)              headIsOn(branch)           detachedHead()
commitCount(ref, n)          commitReachable(ref, msg)  isAncestor(a, b)
noMergeCommits(ref)          isLinear(ref)              workingTreeClean()
fileStaged(path)             fileModified(path)         hasConflict()
tagExists(name)              stashCount(n)              maxCommands(n)
remoteAhead(branch)          trackingSet(branch)        stillReachable(hash)
```

**Gate:** `test/levels.spec.ts` loads every level JSON, replays its canonical solution
through the engine, and asserts `complete === true`; plus at least one deliberately wrong
solution per level that must assert `false`. This suite runs in CI forever — it is what
stops phase 9 from silently breaking level 4.

### Phase 3 — Terminal & command gate
xterm.js wired to `engineClient`. History (↑/↓), tab completion over the unlocked set.
Locked commands rejected in-fiction: `rebase: not yet unlocked — reach Act 4`.
Command log appended to zustand and persisted to IndexedDB.

**Gate:** play a level start to finish by typing only, with correct output and errors.
No graph yet.

### Phase 4 — Graph renderer
Pure function `RepoSnapshot → SVG`. Lane assignment (one lane per active branch tip,
reuse freed lanes). Framer Motion `layoutId` keyed on `StructHash`.

**The rebase case is the hard one and it is the whole point.** Rebase produces *new*
structural hashes, so keyed animation shows a pop-out/pop-in rather than a morph.
`CommandResult` must therefore carry a `rewrites: Record<StructHash, StructHash>` map
(old → new) so the renderer can animate the morph and leave the original faded at
`--st-ghost`. Add that field to `CommandResult` when you reach Act 4 — it is the one
sanctioned type change.

**Gate:** every Act 1–2 level renders correctly; branch, merge, and checkout animate.

### Phase 5 — Three-trees panels
Working tree | index | object store, side by side, files coloured by `FileStatus`,
animating between panels on `add`/`restore`/`commit`.

**Gate:** run `add`, `restore`, `commit`, `reset --soft/--mixed/--hard` and watch the
correct panels change. This panel is what makes `reset` teachable — verify it by eye
before writing Act 4.

### Phase 6 — Level shell
Goal checklist bound to `EvaluationResult` (ticks live after every command). Diagnostic
hints via the predicate registry, tiered fallback ladder auto-offered after 3 failed
commands or 45s idle. Undo = replay `log[0..n-1]`. Reset = replay `[]`. Level complete
screen.

**Gate:** full loop playable including undo, reset, hints, and progression to the next
level, surviving a page refresh.

### Phase 7 — Act 1 content
Eight levels. Branchless. `add -p` included.

**Gate:** three people who don't know Git finish Act 1 without you in the room. This gate
is not optional and not technical — it is the only real signal you have.

### Phase 8 — Site layer
Landing page, per-level explainer routes (SSG), `@vercel/og` images generated from the
same SVG graph components, docs.

**Gate:** Lighthouse ≥ 95 on the landing page, and the landing-page bundle contains
neither `isomorphic-git` nor the graph renderer. Assert this in CI with
`@next/bundle-analyzer` — treat it as a test, not a hope.

### Phase 9 — Remote simulation → Act 3
Second lightning-fs directory as `origin`. Implement `fetch`/`push` between the two
directories directly (no HTTP transport). `remoteCommit` setup op scripts the "teammate
pushed while you worked" scenario deterministically.

**Gate:** a level where `origin/main` visibly moves on `fetch` while `main` stays put.

### Phase 10 — Acts 4–5, telemetry, polish
Rewriting and recovery acts. `POST /api/telemetry` fire-and-forget to Upstash: level id,
command log, outcome, duration. Then read it and fix wherever people quit.

---

## 6. Traps

| Trap | Fix |
|---|---|
| `window is not defined` at build | Everything below `GameShell` is `ssr: false`. Never import it from a server component. |
| StrictMode double-mounts the engine | Make worker bootstrap idempotent; guard with a module-level promise. |
| Structured-clone errors at the worker boundary | Plain JSON only. No `Map`, `Set`, class instances, functions. |
| `isomorphic-git` demands an `http` client | Pass a stub that throws. You never make network calls. |
| Level SHAs differ per run | Fixed author + monotonic timestamps (§3). |
| Landing page 2MB | Route-level splitting + bundle assertion in CI (phase 8 gate). |
| Icon barrel import kills dev server | `optimizePackageImports: ['@phosphor-icons/react']` in `next.config`, and prefer the sprite. |
| Rebase animation pops instead of morphing | The `rewrites` map (phase 4). |
| Level content lives in components | It doesn't. It lives in `/src/content/levels/*.json`, validated by zod. |

---

## 7. Curriculum arc (content spec)

| Act | Levels | Commands | Cliff |
|---|---|---|---|
| 1 — Three trees | 1–8 | `init add commit status diff restore log`, `add -p` | A commit is a snapshot, not a diff |
| 2 — The graph | 9–18 | `branch switch merge tag`, conflicts | A branch is a pointer, not a container |
| 3 — Distributed | 19–28 | `remote clone fetch push pull`, `--force-with-lease` | `origin/main` is a local cache |
| 4 — Rewriting | 29–40 | `amend reset revert cherry-pick rebase -i stash` | Rebase copies; it does not move |
| 5 — Recovery | 41+ | `reflog bisect blame -C -M log -S worktree filter-repo` | The object store is append-only |

Rules that govern every level:

- **Git's error message is the antagonist.** Put the player in a dirty working tree, let
  `switch` fail, and let the error pose the problem `stash` solves. Teaching people to
  *read* git output is the real transferable skill.
- **Observation level before achievement level** at every cliff.
- **Prefer negative assertions over banning commands.** To teach `revert` over `reset`,
  assert `stillReachable(original)` — the player who reaches for `reset` fails on a goal
  that explains the actual difference.
- **Spaced repetition.** Act 4 levels still require Act 1 commands.
- **Act finales** are multi-goal boss levels with a `maxCommands` constraint and no new
  commands.
- Double the runway around **merge conflicts** (Act 2) and **rebase** (Act 4). Those are
  the two attrition cliffs.

---

## 8. Scope discipline

Ship **phases 0–7 as v1** — Act 1 only, eight levels, publicly playable. That is a
complete product, and it is the point at which strangers can tell you whether the core
idea works. Everything after phase 7 is content on top of a proven engine.

The failure mode to avoid is building all five acts against an unvalidated engine.

---

## 9. `AGENTS.md` (drop this at repo root)

```markdown
# Working rules

- `src/core/types.ts` is frozen. Do not regenerate it. If a change is truly needed,
  stop and ask, then log it in DECISIONS.md.
- `src/core/**` is pure TypeScript. No React, no DOM, no browser APIs, no imports
  from `src/game` or `src/engine`.
- Structural hashes, never git SHAs, for any comparison or assertion.
- Levels are data in `src/content/levels/*.json`. Never encode level logic in components.
- Worker boundary carries plain JSON only.
- Every new predicate needs a unit test. Every new level needs a canonical-solution test.
- Persist the command log, never repo bytes.
- One file per change. Ask before touching more than three.
```
