// Turns a snapshot plus a level definition into an EvaluationResult after
// every command. Goals must all pass, constraints must all hold, and the
// first diagnostic whose predicate is currently true gets a say.

import { predicateRegistry } from './predicates';
import type { Assertion, EvaluationResult, LevelDef, RepoSnapshot } from './types';

export interface EvalEnv {
  /** Commands the player has run so far (failed ones included). */
  commandCount: number;
}

export const DEFAULT_ENV: EvalEnv = { commandCount: 0 };

function runAssertion(snap: RepoSnapshot, assertion: Assertion, env: EvalEnv): boolean {
  const entry = predicateRegistry[assertion.assert];
  // Unknown predicate: fail closed. levelSchema refuses unknown keys at load
  // time, so hitting this means a hand-rolled assertion bypassed validation.
  if (!entry) return false;
  const args = [...(assertion.args ?? [])];
  if (entry.needsEnv) args.push(env.commandCount);
  return entry.fn(snap, ...args);
}

export function evaluate(
  snap: RepoSnapshot,
  level: LevelDef,
  env: EvalEnv = DEFAULT_ENV,
): EvaluationResult {
  const goals = level.goals.map((goal) => ({
    label: goal.label,
    passed: runAssertion(snap, goal, env),
  }));
  const constraintsViolated = (level.constraints ?? [])
    .filter((c) => !runAssertion(snap, c, env))
    .map((c) => c.label);
  const fired = (level.diagnostics ?? []).find((d) =>
    runAssertion(snap, { assert: d.when, args: d.args, label: d.say }, env),
  );
  const complete =
    goals.every((g) => g.passed) && constraintsViolated.length === 0;
  return {
    goals,
    constraintsViolated,
    complete,
    ...(fired ? { diagnostic: fired.say } : {}),
  };
}
