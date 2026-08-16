'use client';

// The three-trees panel (BUILD-PLAN Phase 5): working tree | index | object
// store side by side, files coloured by FileStatus. Hue is reserved for
// state; nothing here is coloured for decoration. Chips pop in on first
// appearance, glide on reorder, and their status dot springs between hues.

import { AnimatePresence, motion } from 'framer-motion';
import type { FileEntry, FileStatus, RepoSnapshot } from '@/core/types';
import { derivePanels } from './trees';

const DOT: Record<FileStatus, string> = {
  clean: 'var(--st-clean)',
  untracked: 'var(--st-ghost)',
  modified: 'var(--st-modified)',
  staged: 'var(--st-staged)',
  deleted: 'var(--st-ghost)',
  conflicted: 'var(--st-conflict)',
};

const LABEL: Partial<Record<FileStatus, string>> = {
  untracked: 'untracked',
  modified: 'modified',
  staged: 'staged',
  deleted: 'deleted',
  conflicted: 'conflict',
};

const spring = { type: 'spring', stiffness: 380, damping: 28 } as const;

function FileRow({ entry, onEdit }: { entry: FileEntry; onEdit?: (path: string) => void }) {
  const conflicted = entry.status === 'conflicted';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={spring}
      onClick={onEdit ? () => onEdit(entry.path) : undefined}
      title={onEdit ? 'click to edit' : undefined}
      className={
        'flex items-center gap-2 rounded border border-rule/60 bg-ground/60 px-2 py-1' +
        (onEdit ? ' cursor-pointer transition-colors hover:border-st-head' : '')
      }
    >
      <motion.span
        className="h-2 w-2 shrink-0 rounded-full"
        animate={
          conflicted
            ? { backgroundColor: DOT[entry.status], scale: [1, 1.4, 1] }
            : { backgroundColor: DOT[entry.status], scale: 1 }
        }
        transition={
          conflicted ? { repeat: Infinity, duration: 1.4, ease: 'easeInOut' } : spring
        }
      />
      <span
        className={
          'min-w-0 flex-1 truncate font-mono text-xs ' +
          (entry.status === 'deleted' ? 'text-ink-dim line-through' : 'text-ink')
        }
      >
        {entry.path}
      </span>
      {LABEL[entry.status] ? (
        <span className="font-mono text-[10px]" style={{ color: DOT[entry.status] }}>
          {LABEL[entry.status]}
        </span>
      ) : null}
    </motion.div>
  );
}

function Column({
  title,
  hint,
  files,
  onEdit,
  footer,
}: {
  title: string;
  hint: string;
  files: FileEntry[];
  onEdit?: (path: string) => void;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between px-0.5">
        <p className="font-mono text-[11px] uppercase tracking-widest text-ink">{title}</p>
        <p className="font-mono text-[10px] text-ink-dim">{hint}</p>
      </div>
      <div className="flex min-h-[3.5rem] flex-col gap-1.5 rounded-md border border-rule/40 p-1.5">
        <AnimatePresence initial={false} mode="popLayout">
          {files.map((f) => (
            <FileRow key={f.path} entry={f} onEdit={onEdit} />
          ))}
        </AnimatePresence>
        {files.length === 0 ? (
          <p className="px-1 py-2 font-mono text-[11px] text-ink-dim">empty</p>
        ) : null}
        {footer}
      </div>
    </div>
  );
}

function FlowLabel({ children }: { children: string }) {
  return (
    <div className="flex items-center justify-center self-center pt-6">
      <span className="font-mono text-[10px] text-ink-dim">{children}</span>
    </div>
  );
}

export default function ThreeTrees({
  snapshot,
  onEditFile,
  onNewFile,
}: {
  snapshot: RepoSnapshot;
  onEditFile: (path: string) => void;
  onNewFile: () => void;
}) {
  const panels = derivePanels(snapshot);
  return (
    <section className="rounded-lg border border-rule bg-panel px-3 py-2">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
        <Column
          title="working tree"
          hint="on disk · click to edit"
          files={panels.working}
          onEdit={onEditFile}
          footer={
            <button
              type="button"
              onClick={onNewFile}
              className="rounded border border-dashed border-rule px-2 py-1 font-mono text-[11px] text-ink-dim transition-colors hover:border-st-head hover:text-ink"
            >
              + new file
            </button>
          }
        />
        <FlowLabel>git add →</FlowLabel>
        <Column title="index" hint="staged" files={panels.index} />
        <FlowLabel>git commit →</FlowLabel>
        <Column title="object store" hint="HEAD tree" files={panels.head} />
      </div>
    </section>
  );
}
