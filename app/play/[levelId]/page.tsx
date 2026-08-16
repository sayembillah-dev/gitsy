import PlayClient from '@/game/PlayClient';

// Thin wrapper (BUILD-PLAN §2). Server component: its only job is to hand the
// route param to the client boundary. The island itself is ssr:false.
export default async function PlayPage({
  params,
}: {
  params: Promise<{ levelId: string }>;
}) {
  const { levelId } = await params;
  return <PlayClient levelId={levelId} />;
}
