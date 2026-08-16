// Panel derivation for the three-trees view (BUILD-PLAN Phase 5). Pure:
// RepoSnapshot in, three FileEntry lists out. The snapshot already carries
// the working tree and the index; HEAD's committed tree (the "object store"
// panel) is read off the head commit.

import type { FileEntry, RepoSnapshot } from '@/core/types';

export interface TreePanels {
  working: FileEntry[];
  index: FileEntry[];
  /** HEAD's committed tree. Every entry is clean by definition. */
  head: FileEntry[];
}

const byPath = (a: FileEntry, b: FileEntry): number => a.path.localeCompare(b.path);

export function derivePanels(snap: RepoSnapshot): TreePanels {
  const headHash = snap.head.type === 'detached' ? snap.head.at : snap.branches[snap.head.name];
  const tree = headHash ? snap.commits[headHash]?.tree : undefined;
  const head: FileEntry[] = Object.entries(tree ?? {})
    .map(([path, content]) => ({ path, status: 'clean' as const, content }))
    .sort(byPath);
  return {
    working: [...snap.workingTree].sort(byPath),
    index: [...snap.index].sort(byPath),
    head,
  };
}
