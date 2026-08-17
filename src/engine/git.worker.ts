// Worker entry (BUILD-PLAN section 2). The repo lives in an IndexedDB-backed
// fs so state survives reloads; undo and reset replay the command log (§1).
// Only plain JSON crosses this boundary (Comlink payloads stay dumb).

import * as Comlink from 'comlink';
import LightningFS from '@isomorphic-git/lightning-fs';
import { createEngine } from './createEngine';

// The constructor name is the IndexedDB database name verbatim. It must not
// collide with the command-log DB in persist.ts: same-name DBs are created
// by whoever opens first and the other side never gets its object store.
const fs = new LightningFS('gitsy-repo');

Comlink.expose(createEngine({ fs, dir: '/repo' }));
