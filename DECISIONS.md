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
