// Worker entry (BUILD-PLAN section 2). The repo lives in an IndexedDB-backed
// fs so state survives reloads; undo and reset replay the command log (§1).
// Only plain JSON crosses this boundary (Comlink payloads stay dumb).

import * as Comlink from 'comlink';
import LightningFS from '@isomorphic-git/lightning-fs';
import { createEngine } from './createEngine';

const fs = new LightningFS('gitsy');

Comlink.expose(createEngine({ fs, dir: '/repo' }));
