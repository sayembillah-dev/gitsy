export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-start justify-center gap-6 px-6">
      <p className="font-mono text-sm text-ink-dim">~/gitsy</p>
      <h1 className="text-4xl font-semibold tracking-tight">
        Learn Git by playing it.
      </h1>
      <p className="max-w-prose text-lg text-ink-dim">
        A real Git engine in your browser. A real terminal. No installs, no
        accounts. Just you, three trees, and a graph.
      </p>
      <a
        href="/play/test"
        className="rounded border border-rule bg-panel px-4 py-2 font-mono text-sm text-st-head transition-colors hover:border-st-head"
      >
        $ git init → play
      </a>
    </main>
  );
}
