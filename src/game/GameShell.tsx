'use client';

// The island root (§2). Phase 0 stub — Terminal, Renderer, and Level shell
// mount here from Phase 3 onward.
export default function GameShell({ levelId }: { levelId: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center">
      <p className="font-mono text-sm text-ink-dim">
        island mounted <span className="text-st-head">·</span> level: {levelId}
      </p>
    </main>
  );
}
