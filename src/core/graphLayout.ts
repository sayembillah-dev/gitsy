// RepoSnapshot to a positioned commit graph (BUILD-PLAN Phase 4). Pure and
// deterministic: no timestamps exist in snapshots, so rows come from a
// tips-first topological walk with structural-hash tie-breaks, and lanes are
// assigned greedily by chain, freed lanes reused by later (older) chains.

import type { RepoSnapshot, StructHash } from './types';

export interface GraphNode {
  hash: StructHash;
  message: string;
  lane: number;
  row: number;
  refs: string[];
  isHead: boolean;
  isMerge: boolean;
}

export interface GraphEdge {
  key: string;
  fromLane: number;
  fromRow: number;
  toLane: number;
  toRow: number;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  laneCount: number;
  rowCount: number;
}

export function layoutGraph(snap: RepoSnapshot): GraphLayout {
  // Tip order: HEAD's commit first, then branches and tags by name.
  const tips: StructHash[] = [];
  const headTip =
    snap.head.type === 'detached' ? snap.head.at : snap.branches[snap.head.name];
  if (headTip) tips.push(headTip);
  for (const map of [snap.branches, snap.tags]) {
    for (const name of Object.keys(map).sort()) {
      const h = map[name];
      if (!tips.includes(h)) tips.push(h);
    }
  }

  // Reachable set plus a parent-to-children map.
  const inGraph = new Set<StructHash>();
  const children = new Map<StructHash, StructHash[]>();
  const visit = (h: StructHash): void => {
    if (inGraph.has(h)) return;
    const commit = snap.commits[h];
    if (!commit) return;
    inGraph.add(h);
    for (const p of commit.parents) {
      const list = children.get(p) ?? [];
      list.push(h);
      children.set(p, list);
      visit(p);
    }
  };
  tips.forEach(visit);

  // Rows: Kahn from the tips (a commit gets a row only after every child has
  // one). Queue order: tip order first, structural hash as tie-break.
  const tipRank = new Map(tips.map((t, i) => [t, i]));
  const rank = (h: StructHash) => tipRank.get(h) ?? Number.MAX_SAFE_INTEGER;
  const byOrder = (a: StructHash, b: StructHash) =>
    rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);

  const remainingChildren = new Map(
    [...inGraph].map((h) => [h, (children.get(h) ?? []).length] as const),
  );
  const row = new Map<StructHash, number>();
  const queue: StructHash[] = [...inGraph]
    .filter((h) => (remainingChildren.get(h) ?? 0) === 0)
    .sort(byOrder);
  let nextRow = 0;
  while (queue.length > 0) {
    const h = queue.shift() as StructHash;
    if (row.has(h)) continue;
    row.set(h, nextRow);
    nextRow += 1;
    for (const p of snap.commits[h]?.parents ?? []) {
      const left = (remainingChildren.get(p) ?? 1) - 1;
      remainingChildren.set(p, left);
      if (left === 0) {
        queue.push(p);
        queue.sort(byOrder);
      }
    }
  }

  // Lanes: chains walk first-parent from a tip until they meet an assigned
  // commit. A lane frees below the deepest row it occupies; chains starting
  // lower (older) may reuse it.
  const lane = new Map<StructHash, number>();
  const laneBottom = new Map<number, number>(); // lane -> deepest row used
  const freeFor = (r: number): number => {
    let l = 0;
    while (laneBottom.has(l) && (laneBottom.get(l) as number) >= r) l += 1;
    return l;
  };
  const assignChain = (tip: StructHash): void => {
    const L = freeFor(row.get(tip) ?? 0);
    let cur: StructHash | undefined = tip;
    while (cur !== undefined && !lane.has(cur)) {
      lane.set(cur, L);
      laneBottom.set(L, row.get(cur) ?? 0);
      cur = snap.commits[cur]?.parents[0];
    }
  };
  const byRow = (a: StructHash, b: StructHash) =>
    (row.get(a) ?? 0) - (row.get(b) ?? 0) || byOrder(a, b);
  for (const tip of [...tips].filter((t) => row.has(t)).sort(byRow)) {
    if (!lane.has(tip)) assignChain(tip);
  }
  for (const h of [...inGraph].sort(byRow)) {
    if (!lane.has(h)) assignChain(h);
  }

  const refsOf = (h: StructHash): string[] => [
    ...Object.keys(snap.branches)
      .filter((n) => snap.branches[n] === h)
      .sort(),
    ...Object.keys(snap.remoteBranches)
      .filter((n) => snap.remoteBranches[n] === h)
      .sort(),
    ...Object.keys(snap.tags)
      .filter((n) => snap.tags[n] === h)
      .sort()
      .map((n) => `tag: ${n}`),
  ];

  const nodes: GraphNode[] = [...inGraph].sort(byRow).map((h) => ({
    hash: h,
    message: snap.commits[h]?.message ?? '',
    lane: lane.get(h) ?? 0,
    row: row.get(h) ?? 0,
    refs: refsOf(h),
    isHead: h === headTip,
    isMerge: (snap.commits[h]?.parents.length ?? 0) > 1,
  }));

  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    for (const p of snap.commits[node.hash]?.parents ?? []) {
      if (!lane.has(p) || !row.has(p)) continue;
      edges.push({
        key: `${node.hash}->${p}`,
        fromLane: node.lane,
        fromRow: node.row,
        toLane: lane.get(p) ?? 0,
        toRow: row.get(p) ?? 0,
      });
    }
  }

  const laneCount = Math.max(0, ...nodes.map((n) => n.lane + 1));
  return { nodes, edges, laneCount, rowCount: nodes.length };
}
