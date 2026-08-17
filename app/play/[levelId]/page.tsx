import DungeonClient from '@/game/dungeon/DungeonClient';

// D5 route swap (DUNGEON-SPEC.md): the dungeon is the default game now.
// The classic terminal-first shell lives on at /classic/[levelId].
export default async function PlayPage({
  params,
}: {
  params: Promise<{ levelId: string }>;
}) {
  const { levelId } = await params;
  return <DungeonClient levelId={levelId} />;
}
