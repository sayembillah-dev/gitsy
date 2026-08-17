// Pure walking logic for the dungeon (DUNGEON-SPEC.md D1). Chambers sit at
// graphLayout lane/row coordinates and passages are the layout edges, so
// adjacency and direction picking need no DOM and stay unit-testable.

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface WalkNode {
  hash: string;
  lane: number;
  row: number;
}

export interface WalkEdge {
  fromLane: number;
  fromRow: number;
  toLane: number;
  toRow: number;
}

const coord = (lane: number, row: number) => `${lane}:${row}`;

/** Undirected chamber adjacency: passages walk both ways. */
export function adjacency(nodes: WalkNode[], edges: WalkEdge[]): Map<string, string[]> {
  const hashAt = new Map(nodes.map((n) => [coord(n.lane, n.row), n.hash]));
  const adj = new Map<string, string[]>();
  const link = (a: string | undefined, b: string | undefined) => {
    if (!a || !b) return;
    const la = adj.get(a) ?? [];
    la.push(b);
    adj.set(a, la);
    const lb = adj.get(b) ?? [];
    lb.push(a);
    adj.set(b, lb);
  };
  for (const e of edges) {
    link(hashAt.get(coord(e.fromLane, e.fromRow)), hashAt.get(coord(e.toLane, e.toRow)));
  }
  return adj;
}

const VEC: Record<Dir, readonly [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/** Best neighbor in the pressed direction: farthest along the direction
 *  axis, penalized for sideways drift. Null when nothing lies that way. */
export function pickNeighbor(
  current: WalkNode,
  neighborHashes: string[],
  nodes: WalkNode[],
  dir: Dir,
): string | null {
  const byHash = new Map(nodes.map((n) => [n.hash, n]));
  const [vx, vy] = VEC[dir];
  let best: string | null = null;
  let bestScore = 0.2;
  for (const h of neighborHashes) {
    const n = byHash.get(h);
    if (!n) continue;
    const dx = n.lane - current.lane;
    const dy = n.row - current.row;
    const along = dx * vx + dy * vy;
    if (along <= 0) continue;
    const drift = Math.abs(dx * vy) + Math.abs(dy * vx);
    const score = along - drift * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}
