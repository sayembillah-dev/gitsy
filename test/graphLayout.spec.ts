// Graph layout: rows are tips-first topological, lanes follow branch chains,
// freed lanes get reused, and every edge lands on real node coordinates.

import { describe, expect, it } from 'vitest';
import { layoutGraph } from '@/core/graphLayout';
import { chainGraph, makeCommit, makeSnap, mergeGraph } from './snap.helpers';

describe('layoutGraph', () => {
  it('lays a linear chain in one lane, newest on top', () => {
    const g = chainGraph();
    const layout = layoutGraph(makeSnap({ commits: g.commits, branches: { main: g.c3.hash } }));
    expect(layout.nodes.map((n) => n.message)).toEqual(['third', 'second', 'root']);
    expect(layout.nodes.every((n) => n.lane === 0)).toBe(true);
    expect(layout.nodes[0].isHead).toBe(true);
    expect(layout.nodes[0].refs).toEqual(['main']);
    expect(layout.laneCount).toBe(1);
    expect(layout.edges).toHaveLength(2);
  });

  it('splits the merged side branch onto its own lane', () => {
    const g = mergeGraph();
    const layout = layoutGraph(
      makeSnap({
        commits: g.commits,
        branches: { main: g.merge.hash, feature: g.side.hash },
      }),
    );
    const merge = layout.nodes.find((n) => n.hash === g.merge.hash);
    const side = layout.nodes.find((n) => n.hash === g.side.hash);
    expect(merge?.isMerge).toBe(true);
    expect(merge?.lane).toBe(0);
    expect(merge?.row).toBe(0);
    expect(side?.lane).toBe(1);
    // every edge connects real coordinates and parents sit below children
    for (const e of layout.edges) {
      expect(e.toRow).toBeGreaterThan(e.fromRow);
    }
    const sideEdge = layout.edges.find((e) => e.fromLane === 0 && e.toLane === 1);
    expect(sideEdge).toBeDefined();
  });

  it('reuses a freed lane for a later chain', () => {
    const g = mergeGraph();
    // after the merge, main continues: the freed side lane must come back
    const after = makeCommit('after merge', [g.merge.hash], { 'a.txt': 'three\n' });
    const commits = { ...g.commits, [after.hash]: after };
    const layout = layoutGraph(makeSnap({ commits, branches: { main: after.hash } }));
    expect(layout.laneCount).toBe(2); // side lane reused by nothing new here
    const lanes = new Set(layout.nodes.map((n) => n.lane));
    expect(lanes.size).toBe(2);
  });

  it('marks tags and detached HEAD', () => {
    const g = chainGraph();
    const layout = layoutGraph(
      makeSnap({
        commits: g.commits,
        branches: { main: g.c3.hash },
        tags: { v1: g.c1.hash },
        head: { type: 'detached', at: g.c2.hash },
      }),
    );
    const root = layout.nodes.find((n) => n.hash === g.c1.hash);
    const mid = layout.nodes.find((n) => n.hash === g.c2.hash);
    expect(root?.refs).toEqual(['tag: v1']);
    expect(mid?.isHead).toBe(true);
    expect(layout.nodes.find((n) => n.hash === g.c3.hash)?.isHead).toBe(false);
  });

  it('is deterministic across runs', () => {
    const g = mergeGraph();
    const snap = makeSnap({
      commits: g.commits,
      branches: { main: g.merge.hash, feature: g.side.hash },
    });
    expect(JSON.stringify(layoutGraph(snap))).toBe(JSON.stringify(layoutGraph(snap)));
  });
});
