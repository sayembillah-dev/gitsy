'use client';

// Commit graph renderer (Phase 4; ghosts + rewrite morphs in Phase 10).
// Layout is pure (src/core/graphLayout.ts); this component only paints it.
// Nodes are spring-animated by framer-motion. When a command reports
// `rewrites` (amend/rebase), the NEW node takes the OLD hash as its React
// key, so the spring carries it from the old position (a morph, not a pop),
// while the abandoned original stays behind as a faded ghost.

import { motion } from 'framer-motion';
import { layoutGraph } from '@/core/graphLayout';
import type { RepoSnapshot, StructHash } from '@/core/types';

const LANE_W = 44;
const ROW_H = 40;
const R = 7;
const PAD = 20;
const LABEL_X_OFFSET = 14;

const x = (lane: number) => PAD + lane * LANE_W + LANE_W / 2;
const y = (row: number) => PAD + row * ROW_H + ROW_H / 2;

export default function GraphSvg({
  snapshot,
  rewrites,
}: {
  snapshot: RepoSnapshot;
  /** Old-to-new structural hashes from the last rewriting command. */
  rewrites?: Record<StructHash, StructHash>;
}) {
  const layout = layoutGraph(snapshot);
  const graphW = PAD * 2 + Math.max(1, layout.laneCount) * LANE_W;
  const h = PAD * 2 + Math.max(1, layout.rowCount) * ROW_H;

  // Reverse lookup: new hash -> old hash whose React key it inherits.
  const predecessor = new Map<StructHash, StructHash>();
  for (const [oldHash, newHash] of Object.entries(rewrites ?? {})) {
    predecessor.set(newHash as StructHash, oldHash as StructHash);
  }

  return (
    <div className="relative font-mono" style={{ width: '100%', minWidth: graphW + 220, height: h }}>
      <svg className="absolute inset-0" width={graphW} height={h} aria-hidden>
        {layout.edges.map((e) => {
          const x1 = x(e.fromLane);
          const y1 = y(e.fromRow);
          const x2 = x(e.toLane);
          const y2 = y(e.toRow);
          const midY = (y1 + y2) / 2;
          return (
            <path
              key={e.key}
              d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
              fill="none"
              stroke="var(--st-ghost)"
              strokeWidth={2}
            />
          );
        })}
      </svg>

      {layout.nodes.map((n) => {
        const morphSource = predecessor.get(n.hash);
        const key = n.ghost ? `ghost:${n.hash}` : (morphSource ?? n.hash);
        return (
          <motion.div
            key={key}
            className="absolute"
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{
              opacity: n.ghost ? 0.45 : 1,
              scale: 1,
              x: x(n.lane) - R,
              y: y(n.row) - R,
            }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
          >
            <div
              title={`${n.message}\n${n.hash.slice(0, 8)}${n.ghost ? '\n(abandoned: no ref reaches this commit)' : ''}`}
              className="rounded-full border-2"
              style={{
                width: R * 2,
                height: R * 2,
                borderColor: n.isHead
                  ? 'var(--st-head)'
                  : n.ghost
                    ? 'var(--st-ghost)'
                    : 'var(--rule)',
                backgroundColor: n.isHead
                  ? 'var(--st-head)'
                  : n.ghost
                    ? 'var(--st-ghost)'
                    : 'var(--panel)',
                boxShadow: n.isMerge
                  ? '0 0 0 3px var(--ground), 0 0 0 4px var(--rule)'
                  : undefined,
              }}
            />
            <div
              className="absolute flex items-center gap-1 whitespace-nowrap"
              style={{ left: LABEL_X_OFFSET, top: -2 }}
            >
              {n.refs.map((ref) => (
                <span
                  key={ref}
                  className={
                    ref.startsWith('origin/')
                      ? // Tracking refs wear the HEAD hue (section 4: "HEAD
                        // marker, tracking refs"): they are pointers you own
                        // locally but do not control.
                        'rounded border border-st-head bg-panel px-1.5 py-0.5 text-[10px] text-st-head'
                      : 'rounded border border-rule bg-panel px-1.5 py-0.5 text-[10px] text-ink'
                  }
                >
                  {ref}
                </span>
              ))}
              {n.isHead && (
                <span className="rounded border border-st-head px-1.5 py-0.5 text-[10px] text-st-head">
                  HEAD
                </span>
              )}
              <span className={`pl-1 text-[11px] ${n.ghost ? 'text-st-ghost line-through' : 'text-ink-dim'}`}>
                {n.message}
              </span>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
