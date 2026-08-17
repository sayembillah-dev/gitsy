'use client';

import dynamic from 'next/dynamic';

// Same trap as PlayClient (BUILD-PLAN section 6): the dungeon owns a worker
// and IndexedDB, so it must never render on the server.
const DungeonShell = dynamic(() => import('./DungeonShell'), { ssr: false });

export default function DungeonClient({ levelId }: { levelId: string }) {
  return <DungeonShell levelId={levelId} />;
}
