// Level registry. Levels are data (AGENTS.md); this module only loads the
// JSON files and validates them through the zod schema once at import time,
// so a malformed level fails loudly in dev and in tests.

import { levelDefOf, parseLevelFile, type LevelFile } from '@/core/levelSchema';
import type { LevelDef } from '@/core/types';
import act101 from './levels/act1-01-first-commit.json';
import act102 from './levels/act1-02-take-it-back.json';
import act103 from './levels/act1-03-stage-with-intent.json';

const parsed = [act101, act102, act103].map((json) => parseLevelFile(json));

export const levelList: LevelFile[] = parsed;

const byId = new Map(parsed.map((level) => [level.id, level]));

export function getLevel(id: string): LevelFile | undefined {
  return byId.get(id);
}

export function getLevelDef(id: string): LevelDef | undefined {
  const level = byId.get(id);
  return level ? levelDefOf(level) : undefined;
}
