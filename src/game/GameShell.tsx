'use client';

// The island root (section 2). Boots the worker engine, builds the level,
// hydrates the persisted command log, and wires the terminal session.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getLevel, levelList } from '@/content';
import { levelDefOf } from '@/core/levelSchema';
import type { RepoSnapshot } from '@/core/types';
import { getEngine } from '@/engine/engineClient';
import GraphSvg from './GraphSvg';
import { appendLog, loadLog } from './persist';
import { useGameStore } from './store';
import Terminal from './Terminal';
import { TerminalSession } from './terminalCore';

export default function GameShell({ levelId }: { levelId: string }) {
  const level = getLevel(levelId);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null);
  const [done, setDone] = useState(false);
  const booted = useRef(false);

  useEffect(() => {
    if (!level || booted.current) return;
    booted.current = true;
    void (async () => {
      const engine = await getEngine();
      const first = await engine.buildLevel(level.setup);
      const entries = await loadLog(level.id);
      useGameStore.getState().hydrate(entries);
      setSnapshot(first);
      setSession(
        new TerminalSession({
          engine,
          level: levelDefOf(level),
          onLog: (entry) => {
            useGameStore.getState().appendCommand(entry);
            void appendLog(level.id, entry);
          },
        }),
      );
    })();
  }, [level, levelId]);

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

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-4 px-4 py-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-ink-dim">
            act {level.act} · {level.id}
          </p>
          <h1 className="text-2xl font-semibold text-ink">{level.title}</h1>
        </div>
        <Link href="/" className="font-mono text-xs text-ink-dim hover:text-ink">
          ~/gitsy
        </Link>
      </header>

      <p className="max-w-2xl text-sm leading-relaxed text-ink-dim">{level.brief}</p>

      {done ? (
        <div className="rounded-lg border border-st-staged bg-panel px-4 py-3">
          <p className="font-mono text-sm text-st-staged">
            level complete · {useGameStore.getState().commandLog.length} commands logged
          </p>
        </div>
      ) : null}

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <section className="min-h-[24rem] overflow-hidden rounded-lg border border-rule bg-ground">
          {session ? (
            <Terminal
              session={session}
              history={useGameStore.getState().commandLog}
              onComplete={() => setDone(true)}
              onSnapshot={setSnapshot}
            />
          ) : (
            <p className="p-4 font-mono text-sm text-ink-dim">booting the git engine…</p>
          )}
        </section>

        <section className="overflow-auto rounded-lg border border-rule bg-panel">
          <p className="border-b border-rule px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-ink-dim">
            commit graph
          </p>
          <div className="p-2">
            {snapshot ? (
              <GraphSvg snapshot={snapshot} />
            ) : (
              <p className="p-3 font-mono text-xs text-ink-dim">waiting for the engine…</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
