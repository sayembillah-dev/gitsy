import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Docs',
  description:
    'How Gitsy works: a real Git engine in a Web Worker, three visible trees, and deterministic replay.',
};

const SECTIONS: { k: string; body: string[] }[] = [
  {
    k: 'the engine is real',
    body: [
      'Every keystroke runs against a real Git object store (isomorphic-git) with a real index and a real working tree, hosted in a Web Worker on top of an IndexedDB filesystem. Nothing is faked, and no command is a canned animation.',
      'That choice is pedagogical, not just technical. Git\u2019s error message is the antagonist of this game: when a switch fails because your tree is dirty, the error text you read is the text real Git prints. Learning to read Git is the skill that transfers.',
    ],
  },
  {
    k: 'three trees, made visible',
    body: [
      'Git moves bytes between three places: your working tree, the staging index, and the object store your HEAD points at. Most pain comes from not seeing which tree a command touches. Gitsy draws all three side by side and animates files between them as you type.',
      'Colour is reserved for file state: jade is staged, brass is modified, vermilion is conflict. If something is coloured, it means something.',
    ],
  },
  {
    k: 'the graph',
    body: [
      'Commits are drawn as nodes on lane rails; branches and tags are dimension labels on leader lines, because that is what they are: pointers. Abandoned commits fade to ghost rather than vanishing, because in Git they do not vanish either.',
    ],
  },
  {
    k: 'progress and undo',
    body: [
      'The game persists your command log, never your repo bytes. Refresh the page and your exact position is rebuilt by replaying your log against the level\u2019s setup. Undo and reset truncate the same log and replay the remainder, so every path through a level stays deterministic.',
    ],
  },
  {
    k: 'how levels are checked',
    body: [
      'Goals are pure predicates over a snapshot of your repository: reachability, tree contents, ref positions. A level completes when every goal passes and no constraint is violated. Commands you have not unlocked yet never reach the engine, and never count against par.',
    ],
  },
];

export default function DocsPage() {
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
          <Link
            href="/play/act1-01-first-commit"
            className="text-st-head transition-colors hover:text-ink"
          >
            play
          </Link>
        </nav>
      </header>

      <article className="py-12">
        <p className="mb-2 font-mono text-sm text-ink-dim">~/gitsy/docs</p>
        <h1 className="mb-10 text-3xl font-semibold tracking-tight">How Gitsy works</h1>
        <div className="flex flex-col gap-10">
          {SECTIONS.map((s) => (
            <section key={s.k}>
              <h2 className="mb-3 font-mono text-sm text-st-head">{s.k}</h2>
              {s.body.map((p, i) => (
                <p key={i} className="mb-3 max-w-prose leading-relaxed text-ink-dim">
                  {p}
                </p>
              ))}
            </section>
          ))}
        </div>
      </article>

      <footer className="mt-auto border-t border-rule py-6 font-mono text-xs text-ink-dim">
        <Link href="/learn" className="text-st-head transition-colors hover:text-ink">
          browse the curriculum →
        </Link>
      </footer>
    </main>
  );
}
