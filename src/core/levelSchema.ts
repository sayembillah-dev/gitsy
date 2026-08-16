// Zod schema for level JSON files in src/content/levels. Level content is
// data, never component code (AGENTS.md), and this schema is the border
// control: unknown predicate keys, empty goal lists, and missing canonical
// solutions all fail here, in the test suite, before a player ever sees them.

import { z } from 'zod';
import { predicateRegistry } from './predicates';
import type { LevelDef } from './types';

const setupOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('commit'), message: z.string(), files: z.record(z.string(), z.string()) }),
  z.object({ op: z.literal('branch'), name: z.string().min(1) }),
  z.object({ op: z.literal('checkout'), ref: z.string().min(1) }),
  z.object({ op: z.literal('write'), path: z.string().min(1), content: z.string() }),
  z.object({ op: z.literal('stage'), path: z.string().min(1) }),
  z.object({ op: z.literal('tag'), name: z.string().min(1) }),
  z.object({ op: z.literal('remotePush'), branch: z.string().min(1) }),
  z.object({
    op: z.literal('remoteCommit'),
    message: z.string(),
    files: z.record(z.string(), z.string()),
  }),
]);

const predicateKey = (what: string) =>
  z.string().refine((name) => name in predicateRegistry, {
    message: `${what} names a predicate that is not in the registry`,
  });

const assertionSchema = z.object({
  assert: predicateKey('assert'),
  args: z.array(z.unknown()).optional(),
  label: z.string().min(1),
});

const diagnosticSchema = z.object({
  when: predicateKey('when'),
  args: z.array(z.unknown()).optional(),
  say: z.string().min(1),
});

/**
 * A level file is the frozen LevelDef contract plus its test collateral: the
 * canonical solution and at least one wrong solution. levels.spec.ts replays
 * all of them, forever (BUILD-PLAN phase 2 gate).
 */
export const levelFileSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'id is kebab-case, e.g. act1-03-stage-with-intent'),
  act: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  title: z.string().min(1),
  brief: z.string().min(1),
  setup: z.array(setupOpSchema),
  unlocked: z.array(z.string().min(1)).min(1),
  goals: z.array(assertionSchema).min(1),
  constraints: z.array(assertionSchema).optional(),
  diagnostics: z.array(diagnosticSchema).optional(),
  hints: z.array(z.string().min(1)).min(1),
  par: z.number().int().positive().optional(),
  solution: z.array(z.string().min(1)).min(1),
  wrongSolutions: z.array(z.array(z.string().min(1)).min(1)).min(1),
});

export type LevelFile = z.infer<typeof levelFileSchema>;

/** The LevelDef-shaped portion, safe to hand to evaluate(). */
export function levelDefOf(file: LevelFile): LevelDef {
  const { solution: _solution, wrongSolutions: _wrong, ...def } = file;
  return def;
}

/** Parses unknown JSON into a LevelFile, throwing with readable issues. */
export function parseLevelFile(json: unknown): LevelFile {
  const result = levelFileSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid level file:\n${issues}`);
  }
  return result.data;
}
