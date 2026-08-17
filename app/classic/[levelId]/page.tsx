import PlayClient from '@/game/PlayClient';

// Classic trainer UI (pre-dungeon). Kept as a fallback after the D5 swap:
// /play is the dungeon now, /classic is the terminal-first shell.
export default async function ClassicPage({
  params,
}: {
  params: Promise<{ levelId: string }>;
}) {
  const { levelId } = await params;
  return <PlayClient levelId={levelId} />;
}
