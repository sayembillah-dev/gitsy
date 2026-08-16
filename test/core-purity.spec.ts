// AGENTS.md invariant: src/core is pure TypeScript. No React, no DOM, no
// browser APIs, no imports from src/game or src/engine. This test is the
// enforcement mechanism, not a hope.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_DIR = fileURLToPath(new URL('../src/core/', import.meta.url));

describe('core purity', () => {
  it('src/core imports nothing forbidden', () => {
    const files = readdirSync(CORE_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(join(CORE_DIR, file), 'utf8');
      expect(src, file).not.toMatch(/from ['"]react/);
      expect(src, file).not.toMatch(/from ['"][^'"]*\b(game|engine)\b/);
      expect(src, file).not.toMatch(/\brequire\(/);
    }
  });

  it('src/core references no browser or Node globals', () => {
    const files = readdirSync(CORE_DIR).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const src = readFileSync(join(CORE_DIR, file), 'utf8');
      expect(src, file).not.toMatch(/\b(window|document|localStorage|indexedDB|process)\b/);
    }
  });
});
