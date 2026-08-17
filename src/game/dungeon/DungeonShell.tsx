'use client';

// D2+D3 dungeon shell (DUNGEON-SPEC.md). Boots the worker engine, replays
// the persisted command log, and runs the three modes: EXPLORE (walk the
// chambers, DungeonView), CAST (the Console drawer: real typed git via the
// existing Terminal), EDIT (the Codex: the existing FileEditor). Goals are
// seals on the Door; breaking them all opens the way down.

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { getLevel, levelList } from '@/content';
import { levelDefOf } from '@/core/levelSchema';
import type { EvaluationResult, RepoSnapshot } from '@/core/types';
import { getEngine } from '@/engine/engineClient';
import FileEditor from '../FileEditor';
import Terminal from '../Terminal';
import { loadLog, setLog } from '../persist';
import { commandCountOf, replayEntries } from '../replay';
import { useGameStore } from '../store';
import { sendTelemetry } from '../telemetry';
import { TerminalSession } from '../terminalCore';
import DungeonView from './DungeonView';

type Mode = 'explore' | 'cast' | 'edit';

export default function DungeonShell({ levelId }: { levelId: string }) {
  const level = getLevel(levelId);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null);
  const [evalState, setEvalState] = useState<EvaluationResult | null>(null);
  const [done, setDone] = useState(false);
  const [mode, setMode] = useState<Mode>('explore');
  const [editing, setEditing] = useState<{ path: string | null; content: string } | null>(null);
  const [termEpoch, setTermEpoch] = useState(0);
  const [bootStage, setBootStage] = useState('queued');
  const [bootError, setBootError] = useState<string | null>(null);
  const booted = useRef(false);
  const startedAt = useRef(Date.now());
  const telemetrySent = useRef(false);

  const logLength = useGameStore((s) => s.commandLog.length);

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

  useEffect(() => {
    if (!level || booted.current) return;
    booted.current = true;
    void (async () => {
      const t0 = performance.now();
      const mark = (label: string) => {
        setBootStage(label);
        console.log(`[gitsy dungeon] ${label} (+${Math.round(performance.now() - t0)}ms)`);
      };
      try {
        mark('spawning worker');
        const engine = await getEngine();
        const entries = await loadLog(level.id);
        mark(`log loaded: ${entries.length} entries`);
        mark('raising the dungeon');
        const snap = await replayEntries(engine, level.setup, entries);
        mark('dungeon raised');
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
      } catch (err) {
        console.error('[gitsy dungeon] boot failed', err);
        setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [level]);

  // Modal key routing: capture phase so the Console's xterm cannot swallow
  // Escape. Enter/Space opens the Console from explore; Esc always walks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode === 'explore' && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        setMode('cast');
      } else if (mode === 'cast' && e.key === 'Escape') {
        setMode('explore');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode]);

  /** undo/reset: truncate the log, rebuild, replay. */
  const rewind = async (keep: number) => {
    if (!level) return;
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
    setEditing(null);
    setMode('explore');
    startedAt.current = Date.now();
    telemetrySent.current = false;
    setSession(s);
    setTermEpoch((n) => n + 1);
  };

  if (!level) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6">
        <p className="font-mono text-sm text-ink-dim">
          no floor called <span className="text-ink">{levelId}</span> in these vaults.
        </p>
        <Link href="/" className="font-mono text-xs text-st-head hover:underline">
          back to the surface
        </Link>
      </main>
    );
  }

  const next = levelList[levelList.findIndex((l) => l.id === level.id) + 1];

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-4 px-4 py-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-ink-dim">
            descent {level.act} · floor {level.id}
          </p>
          <h1 className="text-2xl font-semibold text-ink">{level.title}</h1>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs">
          <button
            type="button"
            onClick={() => void rewind(logLength - 1)}
            disabled={logLength === 0}
            className="text-ink-dim transition-colors hover:text-ink disabled:opacity-40"
          >
            undo
          </button>
          <button
            type="button"
            onClick={() => void rewind(0)}
            disabled={logLength === 0}
            className="text-ink-dim transition-colors hover:text-ink disabled:opacity-40"
          >
            reset
          </button>
          <Link href={`/classic/${level.id}`} className="text-ink-dim hover:text-ink">
            classic
          </Link>
          <Link href="/" className="text-ink-dim hover:text-ink">
            ~/gitsy
          </Link>
        </div>
      </header>

      <p className="max-w-2xl text-sm leading-relaxed text-ink-dim">{level.brief}</p>
      {level.act === 1 ? (
        <p className="font-mono text-xs text-st-head">
          first steps: arrows or WASD walk the passages · Enter wakes the Console, where you
          type real git · the Satchel below holds your scrolls (click one to edit) · break
          every seal on the Door to descend
        </p>
      ) : null}

      {/* the Door: every goal is a seal */}
      <section className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-rule bg-panel px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-widest text-ink-dim">
          the door
        </span>
        {(evalState?.goals ?? []).map((g) => (
          <span
            key={g.label}
            className={'font-mono text-xs ' + (g.passed ? 'text-st-staged' : 'text-ink-dim')}
          >
            {g.passed ? '[x]' : '[ ]'} {g.label}
          </span>
        ))}
        {done ? (
          <span className="flex items-center gap-3 font-mono text-xs">
            <span className="text-st-staged">the way down is open</span>
            {next ? (
              <Link
                href={`/dungeon/${next.id}`}
                className="rounded border border-st-head px-3 py-1 text-st-head transition-colors hover:bg-st-head/10"
              >
                descend: {next.title} →
              </Link>
            ) : null}
          </span>
        ) : null}
      </section>

      {bootError ? (
        <div className="rounded-lg border border-rule bg-ground p-4 font-mono text-sm">
          <p className="text-st-conflict">the dungeon failed to rise: {bootError}</p>
        </div>
      ) : snapshot && session ? (
        <>
          <DungeonView snapshot={snapshot} active={mode === 'explore'} />

          {/* the Satchel: click a file to open the Codex on it */}
          <section className="flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-panel px-3 py-2">
            <span className="font-mono text-[11px] uppercase tracking-widest text-ink-dim">
              satchel
            </span>
            {snapshot.workingTree.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => {
                  setEditing({ path: f.path, content: f.content ?? '' });
                  setMode('edit');
                }}
                className={
                  'rounded border border-rule bg-ground px-2 py-1 font-mono text-[11px] transition-colors hover:border-st-head ' +
                  (f.status === 'staged'
                    ? 'text-st-staged'
                    : f.status === 'conflicted'
                      ? 'text-st-conflict'
                      : f.status === 'modified'
                        ? 'text-st-modified'
                        : 'text-ink-dim')
                }
              >
                {f.path}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setEditing({ path: null, content: '' });
                setMode('edit');
              }}
              className="rounded border border-dashed border-rule px-2 py-1 font-mono text-[11px] text-ink-dim transition-colors hover:border-st-head hover:text-ink"
            >
              + new scroll
            </button>
            <span className="ml-auto font-mono text-[10px] text-ink-dim">
              Enter: console · click a scroll: codex
            </span>
          </section>
        </>
      ) : (
        <div className="flex h-[68vh] items-center justify-center rounded-lg border border-rule bg-ground">
          <p className="font-mono text-sm text-ink-dim">
            raising the dungeon… <span className="text-xs opacity-60">{bootStage}</span>
          </p>
        </div>
      )}

      {/* the Console: real typed git, no fake verbs */}
      {mode === 'cast' && session ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-ground/95 backdrop-blur">
          <div className="mx-auto max-w-6xl px-4 py-2">
            <p className="pb-1 font-mono text-[10px] uppercase tracking-widest text-ink-dim">
              the console · type real git · Esc to return to the passages
            </p>
            <div className="h-[38vh] min-h-[16rem] overflow-hidden rounded-lg border border-rule bg-ground">
              <Terminal
                key={termEpoch}
                session={session}
                history={useGameStore.getState().commandLog}
                onComplete={markComplete}
                onSnapshot={setSnapshot}
                onEvaluation={setEvalState}
                onRewrites={() => {}}
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* the Codex */}
      {mode === 'edit' && editing && session ? (
        <FileEditor
          path={editing.path}
          initialContent={editing.content}
          onClose={() => {
            setEditing(null);
            setMode('explore');
          }}
          onSave={(path, content) => {
            void session.editFile(path, content).then((r) => {
              setSnapshot(r.snapshot);
              if (session.evaluation) setEvalState(session.evaluation);
              if (r.complete) markComplete();
              if (r.ok) {
                setEditing(null);
                setMode('explore');
              }
            });
          }}
        />
      ) : null}
    </main>
  );
}
