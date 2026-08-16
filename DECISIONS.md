# Decisions

Type-contract and architecture decisions, logged when they happen.
Format: date, what, why.

## 2026-08-17: Phase 0 scaffold

- `src/core/types.ts` written verbatim from BUILD-PLAN section 3 and frozen.
  Only comment punctuation adjusted afterward (standing style rule: no em dashes).
  No type changes.
- Stack: Next.js 16 (App Router), React 19, TypeScript ^5.9 (strict), Tailwind v4,
  zustand 5, Vitest 4.
- TypeScript pinned to v5 instead of v7 (native port): toolchain stability beats
  novelty for a contract-driven build. Revisit when Next.js + tsgo is proven.
- Design tokens live as raw CSS vars in `app/globals.css` (single source of truth),
  exposed to Tailwind via `@theme inline`.
- Next 16 dropped `optimizePackageImports` from `NextConfig` (build errors on the key).
  The section 6 icon-barrel trap is noted in `next.config.ts` and deferred to
  Phase 4, when `@phosphor-icons/core` actually lands. The SVG sprite is the
  primary path anyway.

## 2026-08-17: Phase 1 headless engine

- `src/core/sha256.ts`: hand-rolled sync SHA-256 with manual UTF-8 encoding.
  The core purity rule bans platform APIs (crypto.subtle is async and
  node:crypto is Node-only), and structural hashing must work identically in
  Node tests and the worker. Tested against published vectors.
- `normalize.ts` consumes a `RawRepo` (plain data read by the engine layer), so
  src/core never imports isomorphic-git. Trailing newlines are stripped from
  commit messages before hashing and display.
- `stash` and `reflog` ship as empty arrays until Acts 4-5. isomorphic-git has
  no reflog; Act 5 will synthesize it from the persisted command log.
- `git add --patch` parses but refuses headless: it needs the interactive
  terminal (Phase 3). Act 1 content includes it, so engine support lands there.
- Commit stdout reports file counts, not insertion/deletion stats. Real stats
  need per-file diffs at commit time; revisit if a level needs them.
- `git diff` output comes from a small LCS line differ (`src/engine/diff.ts`),
  real-git-shaped, 3 lines of context. Game files are tiny; O(n*m) is fine.
- Player commits use author `You <you@gitsy.local>` at wall-clock time. Setup
  commits use `Level Builder <level@game.local>` at T0 + n*60 (section 3
  determinism). Structural hashes exclude both, so replay stays deterministic.
- The section 6 http stub is deferred: no isomorphic-git network call exists
  yet. Add the throwing stub when the first network-shaped API is touched.
- Statuses are computed by content-hash comparison across HEAD/index/workdir
  (`statusRows` in readState.ts), never via isomorphic-git statusMatrix: its
  stat cache treats same-size rewrites inside one mtime second as clean, and
  players hit that constantly. Regression test lives in engine.spec.ts.
- isomorphic-git 1.41 API shapes pinned by failing tests: `readTree` returns
  `{ oid, tree }` where `tree` is the entries array; `hashBlob` returns
  `{ oid, type }`.
- `next-env.d.ts` is gitignored: Next 16 rewrites its imports to `.next/types`
  on build vs `.next/dev/types` on dev, so committing it churns every switch.
- UI direction (user, 2026-08-17): physics-based animation, GSAP allowed.
  BUILD-PLAN mentioned Framer Motion for Phase 4; final choice per component
  at implementation time.

## 2026-08-17: Phase 2 predicates and evaluation

- The 18-predicate registry from section 5 lives in `src/core/predicates.ts`
  as `Record<string, PredicateEntry>`; entries carry a one-line `summary` for
  future hint/tooling copy. Ref arguments accept branch/tag/remote names,
  `HEAD`, or raw structural hashes (`resolveRefish`).
- `maxCommands(n)` cannot read the snapshot, so it is the one entry flagged
  `needsEnv`: `evaluate()` appends the player command count as the final arg.
  Failed commands count toward it, matching how a player experiences a limit.
- `workingTreeClean()` means real `git status` "nothing to commit": BOTH
  panels clean. A staged-but-uncommitted change fails it. This is what makes
  "stage the file" a non-solution in act1-02.
- `isLinear(ref)` currently coincides with `noMergeCommits` plus a single-root
  check (they are equivalent for parent-walk reachability). Kept as a separate
  key because level copy says "linear" and Act 4 may tighten the definition
  without touching level JSON.
- `stillReachable(hash)` counts stash and reflog entries as roots, so Act 5
  recovery levels work once reflog synthesis lands.
- `remoteAhead`/`trackingSet` read `snap.remote`/`remoteBranches` and return
  false until the Phase 9 remote simulation exists. Predicates never throw on
  absent features.
- Level JSON files carry test collateral beyond the frozen LevelDef:
  `solution: string[]` and `wrongSolutions: string[][]` (min 1 each).
  `levelDefOf()` strips them before `evaluate()`. Schema is zod 4 in
  `src/core/levelSchema.ts`; unknown predicate keys fail validation, so a
  typo'd assert dies in the test suite, not in front of a player.
- zod 4 added as a runtime dep of src/core. Purity rule covers platform APIs
  (React/DOM/node), not platform-agnostic libraries; core-purity.spec still
  green.
- Three draft Act 1 levels ship to power the gate (first commit, restore,
  two-commit staging with a maxCommands constraint). Phase 7 expands to the
  full eight; these three are written to survive as v1 content.
- Unknown predicate at evaluate() runtime fails closed (goal counts as not
  passed) instead of throwing: schema validation is the authoring guardrail,
  runtime never crashes the game loop.
- Gate passed: 85 tests across 10 files, including levels.spec.ts replaying
  all 3 levels' canonical and wrong solutions through the real engine.

## 2026-08-17: Phase 3 terminal

- `git add -p` runs as an engine-side session (`src/engine/patch.ts`). The
  frozen `GitEngine` type is untouched: `createEngine` returns `PatchEngine`
  (GitEngine + `answer(input)`), an engine-layer extension. Hunk staging uses
  the write-stage-restore trick, safe because statuses are content-hash based.
  `s`/`e` answers stay in scope-refusals with real-shaped text.
- Patch answers persist as `patch-answer: <key>` log entries so Phase 6 undo
  can replay sessions deterministically. Answers do not count for maxCommands;
  the single `git add -p` command does. Locked (in-fiction) rejections never
  reach the engine and never count.
- `TerminalSession` (src/game/terminalCore.ts) holds ALL game logic: the gate
  test drives it line by line, which is playing by typing. Terminal.tsx is
  only keyboard + paint.
- Empty-commit refusal text is `no changes added to commit` on stdout (real
  git prints it there, exit 1). Terminal renders stdout and stderr alike.
- Level content registry at `src/content/index.ts`: JSON imports validated
  through zod once at module load.
- Landing now links to /play/act1-01-first-commit.
- Gate passed: 98 tests / 12 files, next build clean, /play route HTTP 200.

## 2026-08-17: Phase 4 graph renderer + Act 2 engine commands

- Parser grew Act 2: branch (list/create/-d), switch, checkout (-b), merge,
  tag. All branch-shaped. `checkout <path>` deliberately does NOT exist:
  Act 1 teaches `restore`, and ambiguous pathspecs answer with the real
  "did not match any file(s)" text.
- Merge is hand-rolled (deterministic, no reliance on isomorphic-git's merge):
  ancestor walk finds the base; base === theirs: "Already up to date.";
  base === ours: fast-forward via writeRef + checkout --force; otherwise a
  path-level 3-way. Both-sides-different paths get marker files plus a
  `.git/MERGE_HEAD`; `git commit` then refuses while markers remain and
  creates the two-parent commit (git.commit `parent` override) once clean.
- Dirty-tree switch/merge refusal is NOT implemented: level fiction controls
  tree state. Revisit if an Act 2 level needs the refusal as the antagonist.
- readState marks a workdir file `conflicted` only when MERGE_HEAD exists AND
  the content carries `<<<<<<< `. Content-hash statuses stay the source of
  truth everywhere else.
- Graph layout is pure core (`src/core/graphLayout.ts`): rows from a
  tips-first topological walk (hash tie-breaks, no timestamps), lanes from
  first-parent chains with freed-lane reuse. Rendering (GraphSvg.tsx) is
  framer-motion springs keyed on StructHash: pop-in for new commits, glide
  for lane moves. The `rewrites` morph map stays deferred to Act 4 per the
  plan's one sanctioned type change.
- One Act 2 level ships (act2-01-merge-two-branches) so levels.spec covers
  the merge path forever. Player file EDITING is still impossible; Act 2
  conflict-resolution levels need a small editor surface, planned for the
  Phase 5 panels.
- Gate passed: 114 tests / 14 files, tsc + next build clean, play route 200.

## 2026-08-17: Phase 5 three-trees panels + reset + file editor

- `git reset` lands with the mode-flags subset: --soft moves the ref only,
  --mixed (default) also resets the index, --hard resets all three trees.
  Targets: HEAD, HEAD~n / HEAD^n suffixes, branch, tag, SHA prefix. Path
  resets (`git reset <file>`) are refused with a hint toward
  `git restore --staged`; that lesson stays with restore.
- --mixed implementation: snapshot workdir bytes, writeRef + checkout
  --force (resets index AND workdir), then restore the workdir bytes. Safe
  for the same reason write-stage-restore is: statuses are content-hash
  based, never stat caches. Untracked files survive every mode.
- Any reset mode clears MERGE_HEAD (real git behaviour), which makes
  `git reset --hard HEAD` the taught way to abort a botched merge.
- File editing is now possible via an engine-layer extension
  `EditorEngine extends PatchEngine { editFile(path, content) }`: types.ts
  stays frozen again. It is NOT a terminal command (no grammar, no
  commandCount); the UI editor panel calls it directly. Paths are validated
  against traversal/absolute/.git writes.
- Editor saves persist as `edit-file: <path> <uri-encoded content>` log
  entries, same replay idea as patch-answer: Phase 6 undo/reset replays
  stay deterministic, and levels.spec routes those directive lines to
  engine.editFile so canonical solutions may edit files.
- Three-trees panel (src/game/ThreeTrees.tsx + pure src/game/trees.ts):
  working tree | index | object store side by side, FileStatus hues only,
  framer-motion springs on chips (pop-in, layout glide, pulsing conflict
  dot). Working-tree chips open the editor; "+ new file" creates untracked
  files. The object-store panel is derived from the head commit tree.
- act2-02-resolve-a-conflict ships: first level whose canonical solution
  contains an edit-file directive. levels.spec covers conflict resolution
  forever.
- Gate passed: 130 tests / 16 files, tsc + next build clean, play routes
  (act2-01, act2-02) HTTP 200. Panel transitions are codified in
  test/panels.spec.ts; the visual pass still wants human eyes before Act 4.

## 2026-08-17: Phase 6 level shell

- Refresh now restores exact progress: boot REPLAYS the persisted command
  log (src/game/replay.ts) after buildLevel. The log is the save file; repo
  bytes are never persisted. `patch-answer:` and `edit-file:` directives
  replay through engine.answer / engine.editFile.
- undo = replay log[0..n-1]; reset = replay []. Both truncate the IndexedDB
  record (new persist.setLog), rebuild a fresh TerminalSession, and bump a
  key so xterm remounts against it (the terminal effect binds a session at
  mount; swapping sessions without remount would keep the stale one).
- TerminalSession grew: `restore(snap, commandCount)`, `evaluation` getter,
  `failedCount`, and `hint()`: a firing diagnostic always wins, otherwise
  the level's hint ladder escalates with failed-command count. UI surfaces
  the ladder on demand (hint button) and after 45s idle.
- Goal checklist binds to EvaluationResult and ticks live after every
  submit and every editor save (SubmitResult now carries `evaluation`).
- Complete screen: command count vs par, next-level link, replay button.
- Gate: 133 tests / 17 files, tsc + next build clean. Full-loop-survives-
  refresh is codified in test/replay.spec.ts (structural equality of
  commits/panels; git SHAs are wall-clock display fields, never compared).

## 2026-08-17: Phase 7 Act 1 content (eight levels)

- Act 1 is now eight levels: 01 first commit, 02 restore worktree, 03
  selective staging, 04 track a new file, 05 unstage with restore --staged,
  06 read the diff, 07 stage hunks with add -p, 08 build a story (editor +
  log --oneline). The arc covers the whole Act 1 grammar.
- Gotcha: levels.spec replay routed only `edit-file:` directives, never
  `patch-answer:`, so act1-07's canonical solution failed until the gate
  switched to the shared replayEntries/commandCountOf from src/game/replay.ts.
  One replay implementation now serves undo, refresh, and the gate.
- act1-08 is the first level whose canonical solution uses the file editor;
  act1-07 is the first using an interactive patch session.
- Gate: 149 tests / 17 files, tsc + next build clean, new play routes 200.
  The "three novices finish unaided" leg of the gate is a human playtest;
  it stays open until real users run Act 1.

## Phase 8 — Site layer (8238eda)

- Landing, /learn index, per-level SSG explainers (generateStaticParams),
  /docs, sitemap, robots, icon. All server components; the landing ships
  zero app client JS by construction, not by hope.
- OG images via next/og (the vendored successor of @vercel/og; the plan's
  package name is stale). The graph art is one pure SVG-string builder
  (src/site/graphArt.ts) shared by the landing (inline) and the OG routes
  (data-URI <img>: satori renders <img>, not inline <svg>, and an <img> SVG
  cannot see CSS vars, so the section-4 palette is inlined there. Keep
  graphArt ART_PALETTE in sync with globals.css).
- metadataBase is the placeholder https://gitsy.dev until a deploy domain
  exists.
- Bundle gate (test/site-bundle.spec.ts) has two layers: a source
  import-graph walk from the site entries that must never reach
  src/engine, src/game, or the heavy packages (with a positive control on
  app/play/** so the walker cannot pass vacuously), and a built-artifact
  scan of the Turbopack per-route client-reference manifest + chunk bytes.
  Turbopack (Next 16) writes NO app-build-manifest.json; the scan reads
  .next/server/app/(site)/page_client-reference-manifest.js instead.
  @next/bundle-analyzer was skipped: it targets webpack builds and Next 16
  builds with Turbopack by default.
- Lighthouse gate ran for real (headless Chrome, lighthouse@12):
  performance 97, accessibility 100, best-practices 100, seo 100. The one
  a11y failure was st-ghost text failing contrast ("locked" labels); state
  hues stay off prose, ghost text is for the graph only.
- Gate: 152 tests / 18 files, tsc + next build clean (29 static pages,
  incl. 10 level pages + 10 level OG images), all routes probed 200,
  OG images verified as real PNGs.

## Phase 9 — Remote simulation + Act 3 (8f0303a)

- origin is a second repo directory on the SAME fs (deps.dir + '-origin';
  LightningFS in the worker, sibling dir in tests). No HTTP transport:
  fetch/push copy .git/objects recursively (loose objects are immutable and
  content-addressed, so copy-if-absent is exactly right) and then move refs.
  The section-6 stub-http trap is fully sidestepped.
- fetchFromOrigin updates refs/remotes/origin/* only; local branches never
  move. That asymmetry IS the Act 3 cliff and the gate test: "fetch moves
  origin/main while main stays put" (test/engine-remote.spec.ts).
- pushToOrigin does the real fast-forward check (is the origin tip reachable
  from the pushed tip), real rejection text with hint lines, and
  --force-with-lease as "origin tip must equal our tracking ref". --force
  works too; act3-04's constraint makes force-pushing over a teammate FAIL
  the level, so the lease habit is taught by goals, not lectures.
- pull = fetchFromOrigin + execMerge('origin/<current>'). execMerge and
  resolveRev now resolve remote-tracking names (refs/remotes/<name>), so
  `git merge origin/main` and `git reset --hard origin/main` work anywhere.
- remotePush/remoteCommit setup ops create origin lazily (ensureOrigin) and
  use the same deterministic LEVEL_AUTHOR + monotonic T0 clock. buildLevel
  wipes BOTH dirs, so levels without remote ops have no origin at all.
- snapshot.remote is a full normalized snapshot of the origin repo (types.ts
  field, untouched since Phase 0). remoteSynced predicate joins remoteAhead
  and trackingSet: local tip === remote tip by StructHash equality, which is
  exact because push copies objects and structHash is content-addressed.
- git status gained real tracking lines (up to date / ahead N / behind N /
  diverged N and M) plus the `## main...origin/main [ahead 1]` -sb form.
  Combined short flags (-sb) are parsed, matching real git.
- clone is parsed but always answers in-fiction ("Gitsy repositories arrive
  pre-cloned") and was removed from ACT_OF: lock-copy never made sense for a
  command that can never unlock.
- Act 3 ships five levels: fetch-the-teammates-work (the gate), pull-it-down,
  share-your-work (push), the-race (rejection -> pull -> push; force-push
  kills the constraint), force-with-lease (lease refuses stale, works fresh).
- Gate: 181 tests / 19 files (levels.spec now replays 15 levels), tsc +
  next build clean (34 static pages), act-3 play/learn routes probed 200.
