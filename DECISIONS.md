# Decisions

Type-contract and architecture decisions, logged when they happen.
Format: date, what, why.

## 2026-08-17 — Phase 0 scaffold

- `src/core/types.ts` written verbatim from BUILD-PLAN §3 and frozen. No changes.
- Stack: Next.js 16 (App Router), React 19, TypeScript ^5.9 (strict), Tailwind v4,
  zustand 5, Vitest 4.
- TypeScript pinned to v5 instead of v7 (native port): toolchain stability beats
  novelty for a contract-driven build. Revisit when Next.js + tsgo is proven.
- Design tokens live as raw CSS vars in `app/globals.css` (single source of truth),
  exposed to Tailwind via `@theme inline`.
- Next 16 dropped `optimizePackageImports` from `NextConfig` (build errors on the key).
  The §6 icon-barrel trap is noted in `next.config.ts` and deferred to Phase 4, when
  `@phosphor-icons/core` actually lands — the SVG sprite is the primary path anyway.
