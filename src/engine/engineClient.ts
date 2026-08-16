// Main-thread proxy to the engine worker (BUILD-PLAN section 2).

import * as Comlink from 'comlink';
import type { PatchEngine } from './createEngine';

// Trap (section 6): StrictMode double-mounts the engine. The module-level
// promise makes worker bootstrap idempotent.
let enginePromise: Promise<Comlink.Remote<PatchEngine>> | null = null;

export function getEngine(): Promise<Comlink.Remote<PatchEngine>> {
  if (!enginePromise) {
    const worker = new Worker(new URL('./git.worker.ts', import.meta.url), { type: 'module' });
    enginePromise = Promise.resolve(Comlink.wrap<PatchEngine>(worker));
  }
  return enginePromise;
}
