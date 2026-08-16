// The terminal's brain, decoupled from xterm so the Phase 3 gate can run
// headless: feeding lines through TerminalSession IS playing a level by
// typing. Terminal.tsx is a thin keyboard/display wrapper around this.

import { evaluate } from '@/core/evaluate';
import type { EvaluationResult, LevelDef, RepoSnapshot } from '@/core/types';
import type { EditorEngine } from '@/engine/createEngine';
import { PATCH_PROMPT } from '@/engine/patch';

/** Which act unlocks a command (curriculum table, section 7). */
export const ACT_OF: Record<string, number> = {
  branch: 2,
  switch: 2,
  checkout: 2,
  merge: 2,
  tag: 2,
  remote: 3,
  fetch: 3,
  push: 3,
  pull: 3,
  // clone is deliberately absent: the parser answers it with the in-fiction
  // "Gitsy repositories arrive pre-cloned" message in every act.
  reset: 4,
  revert: 4,
  'cherry-pick': 4,
  rebase: 4,
  stash: 4,
  reflog: 5,
  bisect: 5,
  blame: 5,
  worktree: 5,
  rm: 5,
  mv: 5,
  config: 5,
  show: 5,
};

const BUILTINS = ['help', 'clear'];

export interface SubmitResult {
  stdout: string;
  stderr: string;
  clear?: boolean;
  complete: boolean;
  snapshot?: RepoSnapshot;
  evaluation?: EvaluationResult;
}

export interface TerminalSessionOpts {
  engine: EditorEngine;
  level: LevelDef;
  /** Every engine-bound line is reported here (plus patch-answer entries). */
  onLog?: (entry: string) => void;
  /** Restored command count after a replay (Phase 6). */
  initialCommands?: number;
}

function commandNameOf(line: string): string {
  const words = line.split(/\s+/);
  return words[0] === 'git' ? (words[1] ?? '') : words[0];
}

function helpText(level: LevelDef): string {
  return (
    `unlocked: ${[...level.unlocked].sort().join(', ')}\n` +
    `shell builtins: ${BUILTINS.join(', ')}\n` +
    'everything else is still locked. Keep playing to open it.\n'
  );
}

export class TerminalSession {
  private patchActive = false;
  private commands: number;
  private failed = 0;
  private last: EvaluationResult | null = null;

  constructor(private opts: TerminalSessionOpts) {
    this.commands = opts.initialCommands ?? 0;
  }

  get commandCount(): number {
    return this.commands;
  }

  get failedCount(): number {
    return this.failed;
  }

  get inPatch(): boolean {
    return this.patchActive;
  }

  /** Latest evaluation, for the live goal checklist (Phase 6). */
  get evaluation(): EvaluationResult | null {
    return this.last;
  }

  /** Re-attaches state after a deterministic replay (undo/reset/refresh). */
  restore(snap: RepoSnapshot, commandCount: number): void {
    this.commands = commandCount;
    this.last = evaluate(snap, this.opts.level, { commandCount });
  }

  /**
   * Tiered hint ladder (Phase 6): a firing diagnostic always wins;
   * otherwise the fallback hints escalate with the failed-command count.
   */
  hint(): string {
    const diagnostic = this.last?.diagnostic;
    if (diagnostic) return diagnostic;
    const hints = this.opts.level.hints;
    if (hints.length === 0) return 'git status is never wrong.';
    return hints[Math.min(this.failed, hints.length - 1)];
  }

  /** Completion candidates for Tab: the unlocked set plus builtins. */
  completions(): string[] {
    return [...this.opts.level.unlocked, ...BUILTINS].sort();
  }

  /**
   * UI editor save (Phase 5). Not a terminal command: never counted against
   * maxCommands. Logged as an `edit-file:` directive (path +
   * URI-encoded content) so Phase 6 undo/reset replay stays deterministic.
   */
  async editFile(
    path: string,
    content: string,
  ): Promise<{ ok: boolean; snapshot: RepoSnapshot; complete: boolean }> {
    const r = await this.opts.engine.editFile(path, content);
    if (r.ok) this.opts.onLog?.(`edit-file: ${path} ${encodeURIComponent(content)}`);
    const result = evaluate(r.snapshot, this.opts.level, { commandCount: this.commands });
    this.last = result;
    return { ok: r.ok, snapshot: r.snapshot, complete: result.complete };
  }

  async submit(rawLine: string): Promise<SubmitResult> {
    const { engine, level, onLog } = this.opts;
    const line = rawLine.trim();

    if (this.patchActive) {
      const r = await engine.answer(line);
      if (!r.stdout.endsWith(PATCH_PROMPT)) this.patchActive = false;
      onLog?.(`patch-answer: ${line}`);
      const result = evaluate(r.snapshot, level, { commandCount: this.commands });
      this.last = result;
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        complete: result.complete,
        snapshot: r.snapshot,
        evaluation: result,
      };
    }

    if (line === '') return { stdout: '', stderr: '', complete: false };

    const name = commandNameOf(line);
    if (name === 'clear') return { stdout: '', stderr: '', clear: true, complete: false };
    if (name === 'help') return { stdout: helpText(level), stderr: '', complete: false };

    // The in-fiction lock: known-but-locked commands never reach the engine
    // and never count against maxCommands.
    if (name && !level.unlocked.includes(name)) {
      const act = ACT_OF[name];
      if (act) {
        return {
          stdout: '',
          stderr: `${name}: not yet unlocked - reach Act ${act}\n`,
          complete: false,
        };
      }
      // Unknown names fall through so the engine can answer with the real
      // "git: 'x' is not a git command" text.
    }

    const r = await engine.run(line);
    this.commands += 1;
    if (!r.ok) this.failed += 1;
    onLog?.(line);
    if (r.stdout.endsWith(PATCH_PROMPT)) this.patchActive = true;
    const result = evaluate(r.snapshot, level, { commandCount: this.commands });
    this.last = result;
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      complete: result.complete,
      snapshot: r.snapshot,
      evaluation: result,
    };
  }
}
