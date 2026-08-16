// Signature art for the site layer (Phase 8): the commit graph as a
// drafting object. One geometry, two consumers: the landing page inlines
// the SVG (server-rendered), and the OG image routes embed the same SVG as
// a data URI (an <img> SVG cannot resolve CSS vars, so the section-4
// palette is inlined here. Values mirror app/globals.css; keep in sync).

export const ART_PALETTE = {
  ground: '#101A2B',
  panel: '#16233A',
  rule: '#2A3B57',
  ink: '#DCE6F5',
  inkDim: '#7E93B5',
  head: '#8FB8FF',
  ghost: '#4A5C79',
} as const;

export interface ArtNode {
  id: string;
  lane: number;
  row: number;
  label: string;
  refs?: string[];
  head?: boolean;
  merge?: boolean;
}

export interface ArtEdge {
  from: string;
  to: string;
}

// The demo history: a base, two lines of work, and a merge. The Act 2
// story drawn once, by hand, as data.
export const DEMO_NODES: ArtNode[] = [
  {
    id: 'merge',
    lane: 0,
    row: 0,
    label: 'merge notes into main',
    refs: ['main'],
    head: true,
    merge: true,
  },
  { id: 'app', lane: 0, row: 1, label: 'app v2' },
  { id: 'notes', lane: 1, row: 2, label: 'notes', refs: ['feature'] },
  { id: 'base', lane: 0, row: 3, label: 'base', refs: ['tag: v1'] },
];

export const DEMO_EDGES: ArtEdge[] = [
  { from: 'merge', to: 'app' },
  { from: 'merge', to: 'notes' },
  { from: 'app', to: 'base' },
  { from: 'notes', to: 'base' },
];

const LANE_W = 44;
const ROW_H = 40;
const R = 7;
const PAD = 20;
const FONT = "'JetBrains Mono', ui-monospace, monospace";
const CHAR_W = 6.8; // advance of an 11px monospace glyph, for chip widths

const cx = (lane: number) => PAD + lane * LANE_W + LANE_W / 2;
const cy = (row: number) => PAD + row * ROW_H + ROW_H / 2;

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const chipW = (text: string): number => Math.ceil(text.length * CHAR_W) + 12;

export interface DemoGraphSize {
  width: number;
  height: number;
}

export function demoGraphSize(nodes: ArtNode[] = DEMO_NODES): DemoGraphSize {
  const lanes = Math.max(...nodes.map((n) => n.lane)) + 1;
  const rows = Math.max(...nodes.map((n) => n.row)) + 1;
  let maxLabel = 0;
  for (const n of nodes) {
    const refsW = (n.refs ?? []).reduce((w, r) => w + chipW(r) + 6, 0);
    const headW = n.head ? chipW('HEAD') + 6 : 0;
    maxLabel = Math.max(maxLabel, refsW + headW + Math.ceil(n.label.length * CHAR_W));
  }
  return {
    width: Math.ceil(PAD * 2 + lanes * LANE_W + 14 + maxLabel + PAD),
    height: PAD * 2 + rows * ROW_H,
  };
}

/** The demo graph as a standalone SVG string (no CSS vars, fully inline). */
export function demoGraphSvg(opts: { width?: number; height?: number } = {}): string {
  const nodes = DEMO_NODES;
  const edges = DEMO_EDGES;
  const size = demoGraphSize(nodes);
  const width = opts.width ?? size.width;
  const height = opts.height ?? size.height;
  const laneCount = Math.max(...nodes.map((n) => n.lane)) + 1;
  const rowCount = Math.max(...nodes.map((n) => n.row)) + 1;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const p = ART_PALETTE;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="A commit graph: base, two lines of work, and a merge">`,
  );

  // Lane rails with per-row tick marks: the drafting-table signature.
  for (let lane = 0; lane < laneCount; lane++) {
    const x = cx(lane);
    parts.push(
      `<line x1="${x}" y1="${PAD}" x2="${x}" y2="${height - PAD}" stroke="${p.rule}" stroke-width="1" opacity="0.6"/>`,
    );
    for (let row = 0; row < rowCount; row++) {
      const y = cy(row);
      parts.push(
        `<line x1="${x - 4}" y1="${y}" x2="${x + 4}" y2="${y}" stroke="${p.rule}" stroke-width="1" opacity="0.6"/>`,
      );
    }
  }

  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const x1 = cx(a.lane);
    const y1 = cy(a.row);
    const x2 = cx(b.lane);
    const y2 = cy(b.row);
    const midY = (y1 + y2) / 2;
    parts.push(
      `<path d="M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}" fill="none" stroke="${p.ghost}" stroke-width="2"/>`,
    );
  }

  for (const n of nodes) {
    const x = cx(n.lane);
    const y = cy(n.row);
    if (n.merge) {
      parts.push(
        `<circle cx="${x}" cy="${y}" r="${R + 4}" fill="none" stroke="${p.rule}" stroke-width="1.5"/>`,
      );
    }
    parts.push(
      `<circle cx="${x}" cy="${y}" r="${R}" fill="${n.head ? p.head : p.panel}" stroke="${n.head ? p.head : p.rule}" stroke-width="2"/>`,
    );

    let lx = x + 14;
    for (const ref of n.refs ?? []) {
      const w = chipW(ref);
      parts.push(
        `<rect x="${lx}" y="${y - 9}" width="${w}" height="17" rx="3" fill="${p.panel}" stroke="${p.rule}" stroke-width="1"/>`,
        `<text x="${lx + 6}" y="${y + 3.5}" font-family="${FONT}" font-size="11" fill="${p.ink}">${esc(ref)}</text>`,
      );
      lx += w + 6;
    }
    if (n.head) {
      const w = chipW('HEAD');
      parts.push(
        `<rect x="${lx}" y="${y - 9}" width="${w}" height="17" rx="3" fill="${p.ground}" stroke="${p.head}" stroke-width="1"/>`,
        `<text x="${lx + 6}" y="${y + 3.5}" font-family="${FONT}" font-size="11" fill="${p.head}">HEAD</text>`,
      );
      lx += w + 6;
    }
    parts.push(
      `<text x="${lx + 2}" y="${y + 3.5}" font-family="${FONT}" font-size="11" fill="${p.inkDim}">${esc(n.label)}</text>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}
