// Level briefs are markdown-lite: blank-line paragraphs and `inline code`.
// Deliberately not a real markdown dependency: the site bundle stays small
// and the landing gate (no heavy packages in site routes) keeps its teeth.

import type { ReactNode } from 'react';

function inlineCode(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') ? (
      <code
        key={i}
        className="rounded border border-rule bg-panel px-1 py-0.5 font-mono text-[0.85em] text-st-head"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

export function Brief({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      {text.split(/\n\s*\n/).map((para, i) => (
        <p key={i} className="mb-4 last:mb-0">
          {inlineCode(para)}
        </p>
      ))}
    </div>
  );
}
