# Gitsy Dungeon — Game Layer Design Spec

Status: v0.1, AWAITING SIGN-OFF. No code until this is approved.
This is a presentation layer over the finished 10-phase foundation. The
engine, levels, predicates, persistence, telemetry, and all 270 tests are
untouched. BUILD-PLAN.md remains the foundation spec; this document owns
everything the player sees and does.

## 1. Pillars (non-negotiable)

1. **Real git, always typed.** Every command is executed by the real engine.
   No fake verbs. Spell cards and autocomplete may insert text, but the
   player still edits it and presses Enter. The terminal is sacred.
2. **The dungeon IS the repository.** Rooms are commits, corridors are
   parent links, the hero stands where HEAD stands. If it is not visible in
   git, it is not in the game. No invented mechanics.
3. **Universal floor, expert ceiling.** A kid with zero terminal experience
   starts Act 1; a CS student finishes Act 5 at reflog and bisect. Fiction
   carries beginners; real commands carry everyone.
4. **Juice is curriculum.** Every animation teaches a state change: a room
   forging means a commit exists; a ghost fading means history was rewritten.
   No decoration without information.

## 2. The fiction (working title: The Vaults)

You are a Keeper in the Vaults, a dungeon that remembers everything. It is
built of sealed Chambers joined by Passages, and it is broken into five
Descents. You carry a lantern (you are the HEAD; your light shows where the
work happens) and the Console, an ancient artifact that speaks exactly one
language: git.

| Git concept | In the dungeon |
|---|---|
| commit | a Chamber, forged and sealed |
| parent links | Passages between chambers |
| branch | a Banner planted on a chamber |
| HEAD | where the Keeper stands (lantern light) |
| working tree | your Satchel (what you carry) |
| staging area | the Altar (what you offer) |
| committed tree | the sealed Record |
| checkout / switch | walking (or lantern-leaping) to a chamber |
| merge | two passages sealed into one chamber |
| amend / rebase | chambers re-carved; the abandoned originals linger as Ghosts |
| reflog | the Echo: the dungeon remembers everywhere you stood |
| stash | the Cache niche: stow your satchel, retrieve later |
| detached HEAD | standing in an un-bannered chamber (the warning is a whisper) |
| worktree | a mirrored side-vault of the whole floor |
| bisect | the Trial: torch by torch to the culprit chamber |
| blame | reading the runes: whose hand carved this line |
| level goals | the sealed Door; each goal is a seal that breaks |
| hints | the Whisper (the existing idle hint ladder) |

## 3. Moment-to-moment loop

Three modes, one keymap, modal by design so arrows never fight the terminal:

1. **EXPLORE (default).** Arrow keys / WASD walk the Keeper chamber to
   chamber along passages. Camera follows on a spring. Walking onto a
   chamber inspects it (message, author, runes/files at that commit).
2. **CAST.** Enter or Space opens the Console (bottom drawer, xterm.js,
   restyled as the ancient artifact). Type real git. Tab completion and the
   spellbook (insert-but-does-not-execute cards) live here. Enter executes;
   the world animates the resulting snapshot diff; Esc returns to explore.
3. **EDIT.** Tab (or E) at your current chamber opens the Codex (the
   existing FileEditor). Saving writes the file; the Satchel shows the
   artifact as changed.

Level flow: enter the floor, read the Door (goals), explore + cast + edit
until the seals break, the Door unseals with ceremony, walk through to the
next level. Boss levels are big doors with every skill on the floor.

## 4. Screen layout

```
+--------------------------------------------------------------+
|  ACT 2 . FLOOR 3                                   ~/gitsy   |
|                                                              |
|      [chamber]---[chamber]                                   |
|          |                                                   |
|      [chamber]---[@ keeper]=====[BANNER: feature]            |
|          |                                                   |
|      [ghost chamber]      [DOOR: 2 of 3 seals broken]        |
|        (faded)                                               |
|                                                              |
|   lantern light marks where HEAD stands                      |
+--------------------------------------------------------------+
|  CONSOLE (Enter to cast, Esc to return)                      |
|  keeper@vaults ~/repo $ git commit -m "light the brazier"    |
+--------------------------------------------------------------+
```

Satchel / Altar / Record panels (the current ThreeTrees, re-skinned) slide
in on keys 1 / 2 / 3, and auto-surface in early acts while the concepts
are new. The Door plaque (goal checklist) lives on the right edge.

## 5. What each existing system becomes

| Existing (finished, tested) | Dungeon manifestation |
|---|---|
| `graphLayout.ts` coordinates | chamber positions, verbatim reuse |
| `GraphSvg` morph + ghost rendering | chamber re-carve + ghost fade, in world space |
| `Terminal` / xterm.js | the Console drawer |
| `ThreeTrees` panels | Satchel / Altar / Record in-world panels |
| `FileEditor` | the Codex |
| goal checklist + `predicates.ts` | seals on the Door |
| hint ladder (`terminalCore.hint`) | the Whisper |
| command log + `persist.ts` | unchanged; player position is derived from HEAD, nothing new is persisted |
| `telemetry.ts` | unchanged |
| levels/*.json setups, goals, solutions | unchanged; briefs and hints get a fiction rewrite pass (content only, no schema change) |
| /learn explainer pages | the Keeper's Grimoire, linked from the Door |

## 6. Art direction and tech

- 2D "carved stone and rune glow", all vector (SVG/CSS). No pixel-art
  pipeline, no external assets, nothing to license. Palette extends the
  existing ink / panel / st-* tokens so classic and dungeon modes share a
  soul.
- The Keeper: a small hooded figure with a lantern; light radius = current
  context. Movement and camera on framer-motion springs (already installed).
  GSAP for ambient life (torch flicker, drifting dust).
- Renderer: plain DOM/React, not canvas. Chambers are absolutely positioned
  elements at graphLayout coordinates inside a transformed world container;
  camera = scale + translate springs. Rationale: scenes are tiny (< 25
  chambers), React-idiomatic, and chambers stay real focusable elements with
  accessible names, which matters for a universal audience.
- Walking is constrained to chambers and passages by design: no collision
  system, no physics engine, no tilemap. Movement paths are the parent-edge
  polylines we already compute.
- No new runtime dependencies expected.

## 7. Onboarding (universal audience)

Act 1, Floor 1 is a scripted first five minutes: walk (door: reach the
glowing chamber), open the Console (door: wake the artifact), then type the
first real command letter by letter with the spellbook guiding. Fiction
words come first ("seal this chamber"), the real git word rides alongside
from the first moment, and by Act 2 the fiction words step back. Nothing in
the fiction ever replaces a command name in the Console.

## 8. Phase plan (same gates as the foundation)

| Phase | Scope | Gate |
|---|---|---|
| D1 Walker | dungeon renderer from graphLayout, Keeper walk + camera springs, banners, ghosts | walk a replayed Act 2 level; chambers match the snapshot exactly |
| D2 Console | Console drawer + modal key routing; world reacts to snapshot diffs and the rewrites map | finish act1-01 with zero classic UI |
| D3 Workshop | Codex, Satchel/Altar/Record, Door seals | Acts 1-3 fully playable in dungeon mode |
| D4 Depths | boss rooms, rebase morph spectacle, the Echo (reflog), side-vault (worktree) | Acts 4-5 fully playable; 270 tests still green |
| D5 Onboarding + polish | scripted tutorial, juice pass, perf pass; dungeon becomes the default route | the 3-novice playtest runs in dungeon mode |

Transition plan: dungeon builds at `/dungeon/[levelId]` while the current
UI stays at `/play` (classic mode). At D5 the routes swap and classic
remains as a fallback.

## 9. Non-goals (v1)

Multiplayer, accounts, backend beyond the existing telemetry endpoint,
touch/gamepad input, procedural generation, sound beyond an optional ambient
toggle, any change to the command grammar or engine semantics.

## 10. Open questions for sign-off

1. Fiction name and tone: "The Vaults" / Keeper / lantern. Good, or do you
   want a different skin (same mechanics)?
2. Art direction: carved-stone vector, no pixel art. Confirm.
3. Keyboard-only for v1, touch later. Confirm.
4. Route plan: `/dungeon` during build, swap at D5, classic stays. Confirm.
5. Fiction rewrite of level briefs/hints (goals, setups, solutions
   untouched). Confirm.
