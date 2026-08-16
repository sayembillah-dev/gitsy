'use client';

import dynamic from 'next/dynamic';

// Trap (section 6): everything below GameShell is ssr:false. It will own a
// worker, xterm, and IndexedDB. Never import GameShell from a server component.
const GameShell = dynamic(() => import('./GameShell'), { ssr: false });

export default function PlayClient({ levelId }: { levelId: string }) {
  return <GameShell levelId={levelId} />;
}
