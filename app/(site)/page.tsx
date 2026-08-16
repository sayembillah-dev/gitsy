import Link from 'next/link';
import { levelList } from '@/content';
import { ACTS } from '@/site/acts';
import { demoGraphSvg, demoGraphSize } from '@/site/graphArt';

const FIRST_LEVEL = '/play/act1-01-first-commit';

export default function LandingPage() {
  const size = demoGraphSize();
  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col px-6">
      <header className="flex items-center justify-between border-b border-rule py-4">
        <span className="font-mono text-sm tracking-tight text-ink">gitsy</span>
        <nav className="flex items-center gap-5 font-mono text-xs text-ink-dim">
          <Link href="/learn" className="transition-colors hover:text-ink">
            curriculum
          </Link>
          <Link href="/docs" className="transition-colors hover:text-ink">
            docs
          </Link>
          <Link href={FIRST_LEVEL} className="text-st-head transition-colors hover:text-ink">
            play
          </Link>
        </nav>
      </header>

      <section className="grid items-center gap-10 py-16 md:grid-cols-[1fr_auto] md:py-24">
        <div className="flex flex-col items-start gap-6">
          <p className="font-mono text-sm text-ink-dim">~/gitsy</p>
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
            Learn Git by playing it.
          </h1>
          <p className="max-w-prose text-lg text-ink-dim">
            A real Git engine in your browser. A real terminal. No installs, no
            accounts. Just you, three trees, and a graph.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={FIRST_LEVEL}
              className="rounded border border-rule bg-panel px-4 py-2 font-mono text-sm text-st-head transition-colors hover:border-st-head"
            >
              $ git init → play
            </Link>
            <Link
              href="/learn"
              className="rounded border border-rule px-4 py-2 font-mono text-sm text-ink-dim transition-colors hover:text-ink"
            >
              browse the curriculum
            </Link>
          </div>
        </div>
        <div
          className="justify-self-center overflow-hidden rounded border border-rule bg-panel/40 p-2"
          aria-hidden
          // Server-rendered signature art (src/site/graphArt.ts). Static SVG,
          // zero client JS: the landing bundle stays engine-free by design.
          dangerouslySetInnerHTML={{ __html: demoGraphSvg(size) }}
        />
      </section>

      <section className="grid gap-4 border-t border-rule py-12 md:grid-cols-3">
        {[
          {
            k: 'a real engine',
            body: 'Every command runs a real Git object store inside a Web Worker. The errors are real. That is the point: reading Git\u2019s output is the transferable skill.',
          },
          {
            k: 'three trees, visible',
            body: 'The working tree, the index, and HEAD sit side by side and light up as you add, restore, commit, and reset. Colour means state. Nothing is decoration.',
          },
          {
            k: 'the graph is a drawing',
            body: 'Branches are pointers drawn as dimension labels on rails. When history rewrites, the drawing morphs. You will screenshot the rebase.',
          },
        ].map((c) => (
          <div key={c.k} className="rounded border border-rule bg-panel/40 p-5">
            <h2 className="mb-2 font-mono text-sm text-ink">{c.k}</h2>
            <p className="text-sm leading-relaxed text-ink-dim">{c.body}</p>
          </div>
        ))}
      </section>

      <section className="border-t border-rule py-12">
        <h2 className="mb-6 font-mono text-sm text-ink-dim">five acts. one terminal.</h2>
        <ol className="flex flex-col gap-3">
          {ACTS.map((act) => {
            const levels = levelList.filter((l) => l.act === act.n);
            const playable = levels.length > 0;
            return (
              <li
                key={act.n}
                className="flex flex-col gap-2 rounded border border-rule p-4 md:flex-row md:items-center md:justify-between"
              >
                <div className="flex items-baseline gap-4">
                  <span className="font-mono text-xs text-ink-dim">act {act.n}</span>
                  <span className="font-medium text-ink">{act.name}</span>
                  <span className="hidden text-sm text-ink-dim md:inline">{act.cliff}</span>
                </div>
                {playable ? (
                  <span className="flex flex-wrap gap-2">
                    {levels.map((l) => (
                      <Link
                        key={l.id}
                        href={`/learn/${l.id}`}
                        className="rounded border border-rule px-2 py-1 font-mono text-[11px] text-ink-dim transition-colors hover:border-st-head hover:text-st-head"
                      >
                        {l.title}
                      </Link>
                    ))}
                  </span>
                ) : (
                  <span className="font-mono text-[11px] text-ink-dim">locked</span>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <footer className="mt-auto flex items-center justify-between border-t border-rule py-6 font-mono text-xs text-ink-dim">
        <span>gitsy runs entirely in your browser. your repos never leave the tab.</span>
        <Link href={FIRST_LEVEL} className="text-st-head transition-colors hover:text-ink">
          start →
        </Link>
      </footer>
    </main>
  );
}
