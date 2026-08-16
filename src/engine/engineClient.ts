// Main-thread proxy to the engine worker (BUILD-PLAN section 2).

import * as Comlink from 'comlink';
import type { GitEngine } from '@/core/types';

// Trap (section 6): StrictMode double-mounts the engine. The module-level
// promise makes worker bootstrap idempotent.
let enginePromise: Promise<Comlink.Remote<GitEngine>> | null = null;

export function getEngine(): Promise<Comlink.Remote<GitEngine>> {
  if (!enginePromise) {
    const worker = new Worker(new URL('./git.worker.ts', import.meta.url), { type: 'module' });
    enginePromise = Promise.resolve(Comlink.wrap<GitEngine>(worker));
  }
  return enginePromise;
}
