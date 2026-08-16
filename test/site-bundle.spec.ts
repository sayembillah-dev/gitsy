// Phase 8 gate: the landing-page bundle contains neither isomorphic-git nor
// the graph renderer. Treated as a test, not a hope (BUILD-PLAN phase 8).
//
// Two layers:
//
// 1. Source import-graph walk (always runs). App Router splits code per
//    route, so the landing bundle is exactly what the site entries import.
//    We walk imports from app/layout.tsx + app/(site)/** and assert the
//    engine, the game island, and every heavy package stay unreachable.
//    A positive control (walking app/play/**) MUST reach them, proving the
//    walker is not vacuous.
//
// 2. Built-artifact scan (when .next exists, i.e. CI after `next build`).
//    Turbopack writes per-route client-reference manifests; we assert the
//    landing route references no forbidden module and scan its chunk bytes
//    for forbidden signatures.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const APP = join(ROOT, 'app');
const SRC = join(ROOT, 'src');

const FORBIDDEN_PACKAGES = [
  'isomorphic-git',
  '@isomorphic-git/lightning-fs',
  '@xterm/xterm',
  '@xterm/addon-fit',
  'comlink',
  'framer-motion',
  'zustand',
  'next/og',
];

const FORBIDDEN_PATH = /src[/\\](engine|game)[/\\]/;

/** import/export-from/dynamic-import specifiers, in source order. */
const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function resolveFile(base: string): string | null {
  for (const cand of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

interface Graph {
  files: Set<string>;
  packages: Set<string>;
}

/** All files/packages reachable from `entries`, following local imports. */
function walk(entries: string[]): Graph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      let local: string | null = null;
      if (spec.startsWith('@/')) local = resolveFile(join(SRC, spec.slice(2)));
      else if (spec.startsWith('.')) local = resolveFile(resolve(dirname(file), spec));
      if (local) stack.push(local);
      else {
        packages.add(
          spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0],
        );
      }
    }
  }
  return { files, packages };
}

/** All source files under a directory, recursively. */
function sourcesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

// opengraph-image routes are their OWN route bundles (next/og is legitimate
// there); they are not part of any page's client graph, so they are excluded
// from the site walk. Every other site file must stay engine-free.
const siteEntries = [
  join(APP, 'layout.tsx'),
  ...sourcesUnder(join(APP, '(site)')).filter((f) => !/opengraph-image\.tsx$/.test(f)),
  join(APP, 'sitemap.ts'),
  join(APP, 'robots.ts'),
].filter((f) => existsSync(f));

describe('site bundle isolation', () => {
  it('site routes never reach the engine, the game island, or heavy packages', () => {
    const graph = walk(siteEntries);
    const badFiles = [...graph.files].filter((f) => FORBIDDEN_PATH.test(f));
    const badPackages = [...graph.packages].filter((p) => FORBIDDEN_PACKAGES.includes(p));
    expect(badFiles, `engine/game modules reachable from site: ${badFiles.join(', ')}`).toEqual([]);
    expect(
      badPackages,
      `heavy packages reachable from site: ${badPackages.join(', ')}`,
    ).toEqual([]);
  });

  it('positive control: the play route DOES reach the engine and the island', () => {
    const playEntries = sourcesUnder(join(APP, 'play'));
    expect(playEntries.length).toBeGreaterThan(0);
    const graph = walk(playEntries);
    expect([...graph.files].some((f) => FORBIDDEN_PATH.test(f))).toBe(true);
    expect([...graph.packages].some((p) => FORBIDDEN_PACKAGES.includes(p))).toBe(true);
  });

  it('built landing chunks carry no engine or renderer signatures', () => {
    // Turbopack (Next 16) writes per-route manifests, not app-build-manifest:
    //   .next/server/app/<route>/page_client-reference-manifest.js
    //   .next/server/app/<route>/page/build-manifest.json (rootMainFiles)
    const routeDir = join(ROOT, '.next', 'server', 'app', '(site)');
    const crmPath = join(routeDir, 'page_client-reference-manifest.js');
    const buildManifestPath = join(routeDir, 'page', 'build-manifest.json');
    if (!existsSync(crmPath) || !existsSync(buildManifestPath)) {
      // Source walk above is the gate; this layer runs in CI after a build.
      console.warn('skip: .next not built (run npm run build to enable the chunk scan)');
      return;
    }

    interface ClientRefManifest {
      clientModules?: Record<string, { chunks?: string[] }>;
    }
    const parseClientRef = (path: string): ClientRefManifest => {
      const text = readFileSync(path, 'utf8');
      const m = /\]\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(text);
      if (!m) throw new Error(`cannot parse client-reference manifest: ${path}`);
      return JSON.parse(m[1]);
    };
    const chunkFile = (rel: string): string =>
      join(ROOT, '.next', rel.replace(/^\/?_next\//, ''));

    // Forbidden in module paths (client references) and in chunk bytes.
    const moduleSigs = [
      'isomorphic-git',
      'lightning-fs',
      '@xterm',
      'framer-motion',
      'comlink',
      'zustand',
      'src/game',
      'src/engine',
    ];
    const byteSigs = ['isomorphic-git', 'lightningfs', 'merge_head', 'framer-motion'];

    const modules = Object.keys(parseClientRef(crmPath).clientModules ?? {});
    const chunks = new Set<string>(
      JSON.parse(readFileSync(buildManifestPath, 'utf8')).rootMainFiles ?? [],
    );
    for (const mod of modules) {
      for (const sig of moduleSigs) {
        expect(mod.toLowerCase().includes(sig), `landing references ${sig}: ${mod}`).toBe(false);
      }
      for (const c of parseClientRef(crmPath).clientModules?.[mod]?.chunks ?? []) chunks.add(c);
    }
    expect(chunks.size, 'landing route lists client chunks').toBeGreaterThan(0);
    for (const rel of chunks) {
      const file = chunkFile(rel);
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const sig of byteSigs) {
        expect(text.includes(sig), `${rel} contains forbidden signature "${sig}"`).toBe(false);
      }
      // xterm escape sequences survive minification as source text (\x1b[)
      // or as a raw ESC byte inside a decoded string literal.
      const hasEscapes = text.includes('\\x1b[') || text.includes(String.fromCharCode(27) + '[');
      expect(hasEscapes, `${rel} contains xterm escape sequences`).toBe(false);
    }

    // Positive control: the play route's manifest MUST reference the island,
    // proving these manifests actually see module composition.
    const playCrm = join(
      ROOT,
      '.next',
      'server',
      'app',
      'play',
      '[levelId]',
      'page_client-reference-manifest.js',
    );
    if (existsSync(playCrm)) {
      const playModules = Object.keys(parseClientRef(playCrm).clientModules ?? {});
      expect(
        playModules.some((m) => m.includes('src/game')),
        'play route client-reference manifest should name src/game modules',
      ).toBe(true);
    }
  });
});
