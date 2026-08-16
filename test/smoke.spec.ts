import { describe, expect, it } from 'vitest';

describe('phase 0 scaffold', () => {
  it('loads the frozen type contract as a type-only module', async () => {
    const types = await import('@/core/types');
    // types.ts is type-only: it compiles to an empty module. If this ever
    // gains a runtime export, something has drifted. Keep the contract pure.
    expect(Object.keys(types)).toEqual([]);
  });
});
