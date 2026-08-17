'use client';

// D1 dungeon shell: boots the shared worker engine, replays the persisted
// command log (the save file, unchanged), and hands the snapshot to
// DungeonView. Explore mode only in D1; the Console (D2) and the Codex (D3)
// join later. Same instrumented boot as GameShell so a hang names its stage.

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { getLevel } from '@/content';
import type { RepoSnapshot } from '@/core/types';
import { getEngine } from '@/engine/engineClient';
import { loadLog } from '../persist';
import { replayEntries } from '../replay';
import DungeonView from './DungeonView';

export default function DungeonShell({ levelId }: { levelId: string }) {
  const level = getLevel(levelId);
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null);
  const [bootStage, setBootStage] = useState('queued');
  const [bootError, setBootError] = useState<string | null>(null);
  const booted = useRef(false);

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
        mark('raising the dungeon (buildLevel + replay)');
        const snap = await replayEntries(engine, level.setup, entries);
        mark('dungeon raised');
        setSnapshot(snap);
      } catch (err) {
        console.error('[gitsy dungeon] boot failed', err);
        setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [level]);

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
          <Link href={`/play/${level.id}`} className="text-ink-dim hover:text-ink">
            classic mode
          </Link>
          <Link href="/" className="text-ink-dim hover:text-ink">
            ~/gitsy
          </Link>
        </div>
      </header>

      <p className="max-w-2xl text-sm leading-relaxed text-ink-dim">{level.brief}</p>

      {bootError ? (
        <div className="rounded-lg border border-rule bg-ground p-4 font-mono text-sm">
          <p className="text-st-conflict">the dungeon failed to rise: {bootError}</p>
          <p className="mt-2 text-xs leading-relaxed text-ink-dim">
            console has [gitsy dungeon] stage timings. clearing site data (IndexedDB) and
            reloading starts fresh.
          </p>
        </div>
      ) : snapshot ? (
        <DungeonView snapshot={snapshot} />
      ) : (
        <div className="flex h-[68vh] items-center justify-center rounded-lg border border-rule bg-ground">
          <p className="font-mono text-sm text-ink-dim">
            raising the dungeon… <span className="text-xs opacity-60">{bootStage}</span>
          </p>
        </div>
      )}
    </main>
  );
}
