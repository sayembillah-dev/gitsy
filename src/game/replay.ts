// Deterministic replay of the persisted command log (BUILD-PLAN Phase 6).
// undo = replay log[0..n-1]; reset = replay []; refresh = replay the whole
// log after buildLevel. The log is the source of truth: repo bytes are
// never persisted (section 1 invariant).

import type { RepoSnapshot, SetupOp } from '@/core/types';
import type { EditorEngine } from '@/engine/createEngine';

export const PATCH_PREFIX = 'patch-answer: ';
export const EDIT_PREFIX = 'edit-file: ';

export function isDirective(entry: string): boolean {
  return entry.startsWith(PATCH_PREFIX) || entry.startsWith(EDIT_PREFIX);
}

/** Directives are not commands: only typed git lines count for maxCommands. */
export function commandCountOf(entries: string[]): number {
  return entries.filter((e) => !isDirective(e)).length;
}

/** Rebuilds the level from setup and replays every log entry in order. */
export async function replayEntries(
  engine: EditorEngine,
  setup: SetupOp[],
  entries: string[],
): Promise<RepoSnapshot> {
  let snap = await engine.buildLevel(setup);
  for (const entry of entries) {
    if (entry.startsWith(PATCH_PREFIX)) {
      snap = (await engine.answer(entry.slice(PATCH_PREFIX.length))).snapshot;
    } else if (entry.startsWith(EDIT_PREFIX)) {
      const rest = entry.slice(EDIT_PREFIX.length);
      const space = rest.indexOf(' ');
      snap = (await engine.editFile(rest.slice(0, space), decodeURIComponent(rest.slice(space + 1))))
        .snapshot;
    } else {
      snap = (await engine.run(entry)).snapshot;
    }
  }
  return snap;
}
