import type { Metadata } from 'next';
import Link from 'next/link';
import { levelList } from '@/content';
import { ACTS } from '@/site/acts';

export const metadata: Metadata = {
  title: 'Curriculum',
  description:
    'Five acts take you from git init to the reflog. Every level is a real repository in your browser.',
};

export default function LearnIndex() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col px-6">
      <header className="flex items-center justify-between border-b border-rule py-4">
        <Link href="/" className="font-mono text-sm tracking-tight text-ink">
          gitsy
        </Link>
        <nav className="flex items-center gap-5 font-mono text-xs text-ink-dim">
          <Link href="/docs" className="transition-colors hover:text-ink">
            docs
          </Link>
          <Link
            href="/play/act1-01-first-commit"
            className="text-st-head transition-colors hover:text-ink"
          >
            play
          </Link>
        </nav>
      </header>

      <section className="py-12">
        <p className="mb-2 font-mono text-sm text-ink-dim">~/gitsy/learn</p>
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">The curriculum</h1>
        <p className="mb-10 max-w-prose text-ink-dim">
          Five acts take you from your first commit to surgery on history. Each
          level is a real repository; the terminal only speaks Git.
        </p>

        <div className="flex flex-col gap-10">
          {ACTS.map((act) => {
            const levels = levelList.filter((l) => l.act === act.n);
            return (
              <section key={act.n}>
                <header className="mb-3 flex items-baseline gap-3 border-b border-rule pb-2">
                  <span className="font-mono text-xs text-ink-dim">act {act.n}</span>
                  <h2 className="font-medium text-ink">{act.name}</h2>
                  <span className="text-sm text-ink-dim">{act.cliff}</span>
                </header>
                {levels.length > 0 ? (
                  <ol className="flex flex-col gap-2">
                    {levels.map((l, i) => (
                      <li key={l.id}>
                        <Link
                          href={`/learn/${l.id}`}
                          className="group flex items-baseline justify-between gap-4 rounded border border-rule px-4 py-3 transition-colors hover:border-st-head"
                        >
                          <span className="flex items-baseline gap-3">
                            <span className="font-mono text-xs text-ink-dim">
                              {act.n}.{String(i + 1).padStart(2, '0')}
                            </span>
                            <span className="text-ink group-hover:text-st-head">{l.title}</span>
                          </span>
                          {l.par !== undefined && (
                            <span className="font-mono text-[11px] text-ink-dim">par {l.par}</span>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="px-1 font-mono text-xs text-ink-dim">
                    locked - finish the earlier acts first
                  </p>
                )}
              </section>
            );
          })}
        </div>
      </section>
    </main>
  );
}
