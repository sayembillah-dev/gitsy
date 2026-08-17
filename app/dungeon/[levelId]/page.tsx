import DungeonClient from '@/game/dungeon/DungeonClient';

// Dungeon route (DUNGEON-SPEC.md). Builds alongside classic /play during
// phases D1-D4; the routes swap at D5 after the playtest gate.
export default async function DungeonPage({
  params,
}: {
  params: Promise<{ levelId: string }>;
}) {
  const { levelId } = await params;
  return <DungeonClient levelId={levelId} />;
}
