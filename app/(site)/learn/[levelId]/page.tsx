import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLevel, levelList } from '@/content';
import { ACTS } from '@/site/acts';
import { Brief } from '@/site/md';

// Per-level explainers are static (Phase 8 gate): the whole curriculum
// prerenders at build time.
export function generateStaticParams() {
  return levelList.map((l) => ({ levelId: l.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ levelId: string }>;
}): Promise<Metadata> {
  const { levelId } = await params;
  const level = getLevel(levelId);
  if (!level) return {};
  return {
    title: level.title,
    description: level.brief.split(/\n\s*\n/)[0],
  };
}

export default async function LevelExplainer({
  params,
}: {
  params: Promise<{ levelId: string }>;
}) {
  const { levelId } = await params;
  const level = getLevel(levelId);
  if (!level) notFound();

  const idx = levelList.findIndex((l) => l.id === level.id);
  const prev = idx > 0 ? levelList[idx - 1] : null;
  const next = idx < levelList.length - 1 ? levelList[idx + 1] : null;
  const act = ACTS.find((a) => a.n === level.act);

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col px-6">
      <header className="flex items-center justify-between border-b border-rule py-4">
        <Link href="/" className="font-mono text-sm tracking-tight text-ink">
          gitsy
        </Link>
        <nav className="flex items-center gap-5 font-mono text-xs text-ink-dim">
          <Link href="/learn" className="transition-colors hover:text-ink">
            curriculum
          </Link>
          <Link href="/docs" className="transition-colors hover:text-ink">
            docs
          </Link>
        </nav>
      </header>

      <article className="py-12">
        <p className="mb-2 font-mono text-sm text-ink-dim">
          act {level.act}
          {act ? ` · ${act.name}` : ''}
          {level.par !== undefined ? ` · par ${level.par}` : ''}
        </p>
        <h1 className="mb-6 text-3xl font-semibold tracking-tight">{level.title}</h1>

        <Brief text={level.brief} className="mb-10 max-w-prose leading-relaxed text-ink-dim" />

        <section className="mb-8 rounded border border-rule bg-panel/40 p-5">
          <h2 className="mb-3 font-mono text-sm text-ink">goals</h2>
          <ul className="flex flex-col gap-1.5 font-mono text-sm text-ink-dim">
            {level.goals.map((g) => (
              <li key={g.label}>
                <span className="text-st-clean">[ ]</span> {g.label}
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="mb-3 font-mono text-sm text-ink">unlocked for this level</h2>
          <ul className="flex flex-wrap gap-2">
            {[...level.unlocked].sort().map((cmd) => (
              <li
                key={cmd}
                className="rounded border border-rule px-2 py-1 font-mono text-xs text-ink-dim"
              >
                git {cmd}
              </li>
            ))}
          </ul>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={`/play/${level.id}`}
            className="rounded border border-rule bg-panel px-4 py-2 font-mono text-sm text-st-head transition-colors hover:border-st-head"
          >
            $ play this level →
          </Link>
          <span className="font-mono text-xs text-ink-dim">
            runs locally; progress is saved in your browser
          </span>
        </div>
      </article>

      <footer className="mt-auto flex items-center justify-between border-t border-rule py-6 font-mono text-xs text-ink-dim">
        {prev ? (
          <Link href={`/learn/${prev.id}`} className="transition-colors hover:text-ink">
            ← {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/learn/${next.id}`} className="transition-colors hover:text-ink">
            {next.title} →
          </Link>
        ) : (
          <span />
        )}
      </footer>
    </main>
  );
}
