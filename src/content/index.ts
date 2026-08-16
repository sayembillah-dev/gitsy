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

const parsed = [
  act101, act102, act103, act104, act105, act106, act107, act108,
  act201, act202,
  act301, act302, act303, act304, act305,
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
