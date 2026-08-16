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
