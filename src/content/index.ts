// Level registry. Levels are data (AGENTS.md); this module only loads the
// JSON files and validates them through the zod schema once at import time,
// so a malformed level fails loudly in dev and in tests.

import { levelDefOf, parseLevelFile, type LevelFile } from '@/core/levelSchema';
import type { LevelDef } from '@/core/types';
import act101 from './levels/act1-01-first-commit.json';
import act102 from './levels/act1-02-take-it-back.json';
import act103 from './levels/act1-03-stage-with-intent.json';
import act104 from './levels/act1-04-track-something-new.json';
import act105 from './levels/act1-05-unstage-a-file.json';
import act106 from './levels/act1-06-read-the-diff.json';
import act107 from './levels/act1-07-stage-hunks-not-files.json';
import act108 from './levels/act1-08-tell-the-story.json';
import act201 from './levels/act2-01-merge-two-branches.json';
import act202 from './levels/act2-02-resolve-a-conflict.json';
import act301 from './levels/act3-01-fetch-the-teammates-work.json';
import act302 from './levels/act3-02-pull-it-down.json';
import act303 from './levels/act3-03-share-your-work.json';
import act304 from './levels/act3-04-the-race.json';
import act305 from './levels/act3-05-force-with-lease.json';
import act401 from './levels/act4-01-fix-the-last-commit.json';
import act402 from './levels/act4-02-un-commit-keep-the-work.json';
import act403 from './levels/act4-03-revert-dont-rewrite.json';
import act404 from './levels/act4-04-pick-the-fix.json';
import act405 from './levels/act4-05-rebase-copies-not-moves.json';
import act406 from './levels/act4-06-tidy-the-branch.json';
import act407 from './levels/act4-07-stash-it.json';
import act408 from './levels/act4-08-the-cleanup.json';
import act501 from './levels/act5-01-reflog-rescue.json';
import act502 from './levels/act5-02-bisect-the-break.json';
import act503 from './levels/act5-03-who-wrote-this.json';
import act504 from './levels/act5-04-the-pickaxe.json';
import act505 from './levels/act5-05-a-second-worktree.json';

const parsed = [
  act101, act102, act103, act104, act105, act106, act107, act108,
  act201, act202,
  act301, act302, act303, act304, act305,
  act401, act402, act403, act404, act405, act406, act407, act408,
  act501, act502, act503, act504, act505,
].map((json) => parseLevelFile(json));

export const levelList: LevelFile[] = parsed;

const byId = new Map(parsed.map((level) => [level.id, level]));

export function getLevel(id: string): LevelFile | undefined {
  return byId.get(id);
}

export function getLevelDef(id: string): LevelDef | undefined {
  const level = byId.get(id);
  return level ? levelDefOf(level) : undefined;
}
