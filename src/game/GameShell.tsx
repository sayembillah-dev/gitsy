'use client';

// The island root (section 2) and the Phase 6 level shell. Boots the worker
// engine, REPLAYS the persisted command log (so a refresh restores exact
// progress), and owns undo/reset, the live goal checklist, diagnostics, and
// the tiered hint ladder.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getLevel, levelList } from '@/content';
import { levelDefOf } from '@/core/levelSchema';
import type { EvaluationResult, RepoSnapshot, StructHash } from '@/core/types';
import { getEngine } from '@/engine/engineClient';
import FileEditor from './FileEditor';
import GraphSvg from './GraphSvg';
import { loadLog, setLog } from './persist';
import { commandCountOf, replayEntries } from './replay';
import { useGameStore } from './store';
import { sendTelemetry } from './telemetry';
import Terminal from './Terminal';
import { TerminalSession } from './terminalCore';
import ThreeTrees from './ThreeTrees';

const IDLE_HINT_MS = 45_000;

export default function GameShell({ levelId }: { levelId: string }) {
  const level = getLevel(levelId);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null);
  const [evalState, setEvalState] = useState<EvaluationResult | null>(null);
  const [done, setDone] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  /** path === null means the player is creating a new file. */
  const [editing, setEditing] = useState<{ path: string | null; content: string } | null>(null);
  /** Bumped on undo/reset so the Terminal remounts against the new session. */
  const [termEpoch, setTermEpoch] = useState(0);
  /** Rewrite map from the last history-rewriting command (graph morph). */
  const [rewrites, setRewrites] = useState<Record<StructHash, StructHash> | undefined>(undefined);
  const booted = useRef(false);
  const idleRef = useRef<number>(0);
  /** Telemetry: one event per attempt, on the first completion. */
  const startedAt = useRef(Date.now());
  const telemetrySent = useRef(false);

  const logLength = useGameStore((s) => s.commandLog.length);

  /** First completion of the current attempt: celebrate + fire-and-forget
   *  telemetry. Boot/rewind restores of an already-complete log skip this. */
  const markComplete = () => {
    setDone(true);
    if (!telemetrySent.current && level) {
      telemetrySent.current = true;
      sendTelemetry({
        levelId: level.id,
        log: useGameStore.getState().commandLog,
        outcome: 'complete',
        durationMs: Date.now() - startedAt.current,
      });
    }
  };

  // Boot: buildLevel, then replay the persisted log. The log is the save
  // file; a refresh restores exact progress.
  useEffect(() => {
    if (!level || booted.current) return;
    booted.current = true;
    void (async () => {
      const engine = await getEngine();
      const entries = await loadLog(level.id);
      const snap = await replayEntries(engine, level.setup, entries);
      useGameStore.getState().hydrate(entries);
      const s = new TerminalSession({
        engine,
        level: levelDefOf(level),
        onLog: (entry) => {
          useGameStore.getState().appendCommand(entry);
          void setLog(level.id, useGameStore.getState().commandLog);
        },
      });
      s.restore(snap, commandCountOf(entries));
      setSnapshot(snap);
      setEvalState(s.evaluation);
      setDone(s.evaluation?.complete ?? false);
      setSession(s);
    })();
  }, [level, levelId]);

  // Idle hint ladder: 45s without a state change surfaces the next hint.
  useEffect(() => {
    window.clearTimeout(idleRef.current);
    if (!session || done) return;
    idleRef.current = window.setTimeout(() => setHint(session.hint()), IDLE_HINT_MS);
    return () => window.clearTimeout(idleRef.current);
  }, [snapshot, session, done]);

  if (!level) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6">
        <p className="font-mono text-sm text-ink-dim">
          no level called <span className="text-ink">{levelId}</span>. pick one:
        </p>
        <ul className="flex flex-col gap-3">
          {levelList.map((l) => (
            <li key={l.id}>
              <Link
                href={`/play/${l.id}`}
                className="block rounded-lg border border-rule bg-panel px-4 py-3 transition-colors hover:border-st-head"
              >
                <span className="font-mono text-xs text-ink-dim">act {l.act}</span>
                <span className="ml-3 font-medium text-ink">{l.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  /** undo/reset: truncate the log, rebuild, replay. */
  const rewind = async (keep: number) => {
    const entries = useGameStore.getState().commandLog.slice(0, keep);
    const engine = await getEngine();
    const snap = await replayEntries(engine, level.setup, entries);
    useGameStore.getState().hydrate(entries);
    await setLog(level.id, entries);
    const s = new TerminalSession({
      engine,
      level: levelDefOf(level),
      onLog: (entry) => {
        useGameStore.getState().appendCommand(entry);
        void setLog(level.id, useGameStore.getState().commandLog);
      },
    });
    s.restore(snap, commandCountOf(entries));
    setSnapshot(snap);
    setEvalState(s.evaluation);
    setDone(s.evaluation?.complete ?? false);
    setHint(null);
    setEditing(null);
    setRewrites(undefined);
    startedAt.current = Date.now();
    telemetrySent.current = false;
    setSession(s);
    setTermEpoch((n) => n + 1);
  };

  const next = levelList[levelList.findIndex((l) => l.id === level.id) + 1];
  const diagnostic = evalState?.diagnostic;

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-4 px-4 py-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-ink-dim">
            act {level.act} · {level.id}
          </p>
          <h1 className="text-2xl font-semibold text-ink">{level.title}</h1>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs">
          <button
            type="button"
            onClick={() => void rewind(logLength - 1)}
            disabled={logLength === 0}
            className="text-ink-dim transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            undo
          </button>
          <button
            type="button"
            onClick={() => void rewind(0)}
            disabled={logLength === 0}
            className="text-ink-dim transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            reset
          </button>
          <Link href="/" className="text-ink-dim hover:text-ink">
            ~/gitsy
          </Link>
        </div>
      </header>

      <p className="max-w-2xl text-sm leading-relaxed text-ink-dim">{level.brief}</p>

      {done ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-st-staged bg-panel px-4 py-3">
          <div>
            <p className="font-mono text-sm text-st-staged">level complete</p>
            <p className="font-mono text-xs text-ink-dim">
              {commandCountOf(useGameStore.getState().commandLog)} commands
              {level.par ? ` · par ${level.par}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-3 font-mono text-xs">
            <button
              type="button"
              onClick={() => void rewind(0)}
              className="text-ink-dim transition-colors hover:text-ink"
            >
              replay from scratch
            </button>
            {next ? (
              <Link
                href={`/play/${next.id}`}
                className="rounded border border-st-head px-3 py-1.5 text-st-head transition-colors hover:bg-st-head/10"
              >
                next: {next.title} →
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      {snapshot && session ? (
        <ThreeTrees
          snapshot={snapshot}
          onEditFile={(path) => {
            const entry = snapshot.workingTree.find((f) => f.path === path);
            setEditing({ path, content: entry?.content ?? '' });
          }}
          onNewFile={() => setEditing({ path: null, content: '' })}
        />
      ) : null}

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <section className="min-h-[24rem] overflow-hidden rounded-lg border border-rule bg-ground">
          {session ? (
            <Terminal
              key={termEpoch}
              session={session}
              history={useGameStore.getState().commandLog}
              onComplete={markComplete}
              onSnapshot={setSnapshot}
              onEvaluation={setEvalState}
              onRewrites={setRewrites}
            />
          ) : (
            <p className="p-4 font-mono text-sm text-ink-dim">booting the git engine…</p>
          )}
        </section>

        <div className="flex flex-col gap-4">
          <section className="rounded-lg border border-rule bg-panel">
            <div className="flex items-center justify-between border-b border-rule px-3 py-2">
              <p className="font-mono text-[11px] uppercase tracking-widest text-ink-dim">goals</p>
              <button
                type="button"
                onClick={() => setHint(session?.hint() ?? null)}
                className="font-mono text-[11px] text-ink-dim transition-colors hover:text-ink"
              >
                hint
              </button>
            </div>
            <ul className="flex flex-col gap-1 px-3 py-2">
              {(evalState?.goals ?? []).map((g) => (
                <li
                  key={g.label}
                  className={
                    'font-mono text-xs ' + (g.passed ? 'text-st-staged' : 'text-ink-dim')
                  }
                >
                  {g.passed ? '[x]' : '[ ]'} {g.label}
                </li>
              ))}
            </ul>
            {evalState && evalState.constraintsViolated.length > 0 ? (
              <p className="border-t border-rule px-3 py-2 font-mono text-xs text-st-conflict">
                {evalState.constraintsViolated.join(' · ')}
              </p>
            ) : null}
            {diagnostic || hint ? (
              <p className="border-t border-rule px-3 py-2 font-mono text-xs leading-relaxed text-st-modified">
                {diagnostic ?? hint}
              </p>
            ) : null}
          </section>

          <section className="overflow-auto rounded-lg border border-rule bg-panel">
            <p className="border-b border-rule px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-ink-dim">
              commit graph
            </p>
            <div className="p-2">
              {snapshot ? (
                <GraphSvg snapshot={snapshot} rewrites={rewrites} />
              ) : (
                <p className="p-3 font-mono text-xs text-ink-dim">waiting for the engine…</p>
              )}
            </div>
          </section>
        </div>
      </div>

      {editing && session ? (
        <FileEditor
          path={editing.path}
          initialContent={editing.content}
          onClose={() => setEditing(null)}
          onSave={(path, content) => {
            void session.editFile(path, content).then((r) => {
              setSnapshot(r.snapshot);
              if (session.evaluation) setEvalState(session.evaluation);
              if (r.complete) markComplete();
              if (r.ok) setEditing(null);
            });
          }}
        />
      ) : null}
    </main>
  );
}
