// D1 gate: the dungeon walking logic (DUNGEON-SPEC.md). Pure, no DOM.

import { describe, expect, it } from 'vitest';
import { adjacency, pickNeighbor, type WalkEdge, type WalkNode } from '../src/game/dungeon/walk';

//   A(0,0)
//   |
//   B(0,1) --- C(1,1)
//   |
//   D(0,2) --- E(1,2)
const nodes: WalkNode[] = [
  { hash: 'A', lane: 0, row: 0 },
  { hash: 'B', lane: 0, row: 1 },
  { hash: 'C', lane: 1, row: 1 },
  { hash: 'D', lane: 0, row: 2 },
  { hash: 'E', lane: 1, row: 2 },
];
const edges: WalkEdge[] = [
  { fromLane: 0, fromRow: 0, toLane: 0, toRow: 1 }, // A-B
  { fromLane: 1, fromRow: 1, toLane: 0, toRow: 1 }, // C-B
  { fromLane: 0, fromRow: 1, toLane: 0, toRow: 2 }, // B-D
  { fromLane: 1, fromRow: 2, toLane: 0, toRow: 2 }, // E-D
];
const adj = adjacency(nodes, edges);

describe('adjacency', () => {
  it('links passages both ways', () => {
    expect(adj.get('A')).toEqual(['B']);
    expect(adj.get('B')?.sort()).toEqual(['A', 'C', 'D']);
    expect(adj.get('E')).toEqual(['D']);
  });

  it('skips edges that land on no chamber', () => {
    const dangling = adjacency(nodes, [{ fromLane: 9, fromRow: 9, toLane: 0, toRow: 0 }]);
    expect(dangling.get('A')).toBeUndefined();
  });
});

describe('pickNeighbor', () => {
  const at = (hash: string) => nodes.find((n) => n.hash === hash) as WalkNode;
  const go = (hash: string, dir: 'up' | 'down' | 'left' | 'right') =>
    pickNeighbor(at(hash), adj.get(hash) ?? [], nodes, dir);

  it('walks the main chain up and down', () => {
    expect(go('B', 'up')).toBe('A');
    expect(go('B', 'down')).toBe('D');
    expect(go('A', 'down')).toBe('B');
  });

  it('walks sideways across a fork', () => {
    expect(go('B', 'right')).toBe('C');
    expect(go('C', 'left')).toBe('B');
  });

  it('returns null when nothing lies that way', () => {
    expect(go('B', 'left')).toBeNull();
    expect(go('A', 'up')).toBeNull();
    expect(go('C', 'right')).toBeNull();
  });

  it('prefers the straight passage over a diagonal one', () => {
    // From B: C is straight right (score 1), a hypothetical F at (1,0) would
    // be right-and-up (score 1 - 0.6 = 0.4). Straight must win.
    const withF: WalkNode[] = [...nodes, { hash: 'F', lane: 1, row: 0 }];
    expect(pickNeighbor(at('B'), ['C', 'F'], withF, 'right')).toBe('C');
    expect(pickNeighbor(at('B'), ['A', 'F'], withF, 'up')).toBe('A');
  });

  it('ignores neighbor hashes that name no chamber', () => {
    expect(pickNeighbor(at('B'), ['ZZZ'], nodes, 'right')).toBeNull();
  });
});
