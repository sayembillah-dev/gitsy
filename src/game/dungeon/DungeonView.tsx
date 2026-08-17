'use client';

// D1 Walker: the dungeon IS the repository (DUNGEON-SPEC.md). Chambers are
// commits at graphLayout coordinates, corridors are parent edges, banners
// are branch refs, and the Keeper (who carries the lantern that marks HEAD)
// walks it all with arrows/WASD. Explore mode only; the Console lands in D2.

import { motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutGraph } from '@/core/graphLayout';
import type { RepoSnapshot } from '@/core/types';
import { adjacency, pickNeighbor, type Dir, type WalkEdge, type WalkNode } from './walk';

const LANE_W = 150;
const ROW_H = 120;
const PAD = 150;
const CH_W = 110;
const CH_H = 70;

const cx = (lane: number) => PAD + lane * LANE_W + LANE_W / 2;
const cy = (row: number) => PAD + row * ROW_H + ROW_H / 2;
const short = (h: string) => h.slice(0, 7);
const firstLine = (m: string) => m.split('\n')[0];

const KEYMAP: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
  W: 'up',
  S: 'down',
  A: 'left',
  D: 'right',
};

export default function DungeonView({ snapshot }: { snapshot: RepoSnapshot }) {
  const layout = useMemo(() => layoutGraph(snapshot), [snapshot]);
  const walkNodes = useMemo<WalkNode[]>(
    () => layout.nodes.map((n) => ({ hash: n.hash, lane: n.lane, row: n.row })),
    [layout],
  );
  const walkEdges = useMemo<WalkEdge[]>(
    () =>
      layout.edges.map((e) => ({
        fromLane: e.fromLane,
        fromRow: e.fromRow,
        toLane: e.toLane,
        toRow: e.toRow,
      })),
    [layout],
  );
  const adj = useMemo(() => adjacency(walkNodes, walkEdges), [walkNodes, walkEdges]);
  const byHash = useMemo(
    () => new Map(layout.nodes.map((n) => [n.hash as string, n])),
    [layout],
  );
  const headHash = layout.nodes.find((n) => n.isHead)?.hash as string | undefined;

  const [current, setCurrent] = useState<string | null>(null);
  const lastHead = useRef<string | undefined>(undefined);

  // Spawn at HEAD. If a cast moves HEAD while the Keeper stands on it, the
  // Keeper moves with it (matters from D2 onward). Wandered off? Stay put.
  useEffect(() => {
    setCurrent((cur) => {
      if (!cur) return headHash ?? null;
      if (cur === lastHead.current && headHash && headHash !== lastHead.current) return headHash;
      if (!byHash.has(cur)) return headHash ?? null;
      return cur;
    });
    lastHead.current = headHash;
  }, [headHash, byHash]);

  // Explore-mode key routing. D2 adds cast mode, which takes over these keys
  // while the Console is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = KEYMAP[e.key];
      if (!dir) return;
      e.preventDefault();
      setCurrent((cur) => {
        const node = cur ? byHash.get(cur) : undefined;
        if (!node) return cur;
        return pickNeighbor(node, adj.get(node.hash) ?? [], walkNodes, dir) ?? cur;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [adj, byHash, walkNodes]);

  // Camera: keep the Keeper in the upper third so the plaque and future
  // Door have room below.
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 900, h: 560 });
  useEffect(() => {
    const measure = () => {
      const r = boxRef.current?.getBoundingClientRect();
      if (r && r.width > 0) setBox({ w: r.width, h: r.height });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const curNode = current ? byHash.get(current) : undefined;
  const kx = curNode ? cx(curNode.lane) : PAD;
  const ky = curNode ? cy(curNode.row) : PAD;
  const worldW = PAD * 2 + Math.max(1, layout.laneCount) * LANE_W;
  const worldH = PAD * 2 + Math.max(1, layout.rowCount) * ROW_H;

  return (
    <div
      ref={boxRef}
      className="relative h-[68vh] min-h-[26rem] overflow-hidden rounded-lg border border-rule bg-ground"
    >
      <motion.div
        className="absolute left-0 top-0"
        style={{ width: worldW, height: worldH }}
        animate={{ x: box.w / 2 - kx, y: box.h / 3 - ky }}
        transition={{ type: 'spring', stiffness: 70, damping: 20 }}
      >
        {/* corridors: one smooth path per parent edge */}
        <svg width={worldW} height={worldH} className="absolute left-0 top-0 text-rule">
          {layout.edges.map((e) => {
            const x1 = cx(e.fromLane);
            const y1 = cy(e.fromRow);
            const x2 = cx(e.toLane);
            const y2 = cy(e.toRow);
            const midY = (y1 + y2) / 2;
            return (
              <path
                key={e.key}
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
                strokeLinecap="round"
                opacity={0.7}
              />
            );
          })}
        </svg>

        {/* chambers */}
        {layout.nodes.map((n, i) => {
          const selected = n.hash === current;
          return (
            <motion.div
              key={n.hash}
              className={
                'absolute flex flex-col items-center justify-center rounded-xl border font-mono ' +
                (n.ghost
                  ? 'border-dashed border-rule bg-panel/40 text-ink-dim'
                  : selected
                    ? 'border-st-head bg-panel text-ink shadow-[0_0_36px_rgba(120,160,255,0.15)]'
                    : n.isHead
                      ? 'border-st-head/60 bg-panel text-ink'
                      : 'border-rule bg-panel text-ink'
              )}
              style={{
                left: cx(n.lane) - CH_W / 2,
                top: cy(n.row) - CH_H / 2,
                width: CH_W,
                height: CH_H,
              }}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: n.ghost ? 0.4 : 1, scale: selected ? 1.06 : 1 }}
              transition={{ delay: i * 0.04, type: 'spring', stiffness: 220, damping: 20 }}
            >
              {n.refs.length > 0 ? (
                <div className="absolute -top-7 left-1/2 flex -translate-x-1/2 gap-1 whitespace-nowrap">
                  {n.refs.map((r) => (
                    <span
                      key={r}
                      className="rounded border border-st-head/40 bg-ground px-1.5 py-0.5 text-[9px] text-st-head"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              ) : null}
              <span
                className={
                  'block h-2.5 w-2.5 rotate-45 ' +
                  (n.ghost ? 'bg-ink-dim/40' : 'bg-st-head/80')
                }
              />
              <span className="mt-1 text-[10px]">{short(n.hash)}</span>
              {n.isMerge ? (
                <span className="mt-0.5 text-[8px] text-ink-dim">two passages sealed</span>
              ) : null}
            </motion.div>
          );
        })}

        {/* the Keeper: hooded lantern-bearer standing on the current chamber */}
        {curNode ? (
          <motion.div
            className="pointer-events-none absolute z-10"
            animate={{ left: kx - 15, top: ky - CH_H / 2 - 34 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
          >
            <div className="absolute -inset-24 rounded-full bg-[radial-gradient(circle,rgba(250,200,120,0.14),transparent_65%)]" />
            <svg width="30" height="38" viewBox="0 0 30 38" className="relative text-ink">
              <path
                d="M15 3C8.5 3 4.5 9.5 4.5 15.5V31h21V15.5C25.5 9.5 21.5 3 15 3Z"
                fill="#141824"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <circle cx="11.5" cy="17" r="1.6" className="fill-st-head" />
              <circle cx="18.5" cy="17" r="1.6" className="fill-st-head" />
              <rect x="23.5" y="24" width="5" height="7" rx="1.5" className="fill-st-head opacity-90" />
            </svg>
          </motion.div>
        ) : null}
      </motion.div>

      {/* chamber plaque */}
      <div className="absolute bottom-3 left-3 max-w-sm rounded-lg border border-rule bg-panel/90 px-3 py-2 font-mono text-xs backdrop-blur">
        {curNode ? (
          <>
            <p className="text-ink">
              chamber {short(curNode.hash)}
              {curNode.isHead ? (
                <span className="ml-2 text-st-head">your lantern rests here (HEAD)</span>
              ) : null}
              {curNode.ghost ? (
                <span className="ml-2 text-ink-dim">a ghost of rewritten history</span>
              ) : null}
            </p>
            <p className="mt-1 text-ink-dim">{firstLine(curNode.message)}</p>
          </>
        ) : null}
        <p className="mt-1 text-[10px] text-ink-dim">arrows / WASD to walk the passages</p>
      </div>
    </div>
  );
}
