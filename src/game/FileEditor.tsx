'use client';

// The file editor surface (Phase 5). Saving writes bytes straight to the
// workdir through TerminalSession.editFile, which is what makes Act 2
// conflict-resolution levels playable. Escape cancels, Ctrl/Cmd+Enter saves.

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

const BAD_NAME = /^\s*$|\s|\.\.|^\.git(\/|$)|^[A-Za-z]:|^\/|\\/;

export default function FileEditor({
  path,
  initialContent,
  onSave,
  onClose,
}: {
  /** null means "create a new file": a name field is shown. */
  path: string | null;
  initialContent: string;
  onSave: (path: string, content: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [content, setContent] = useState(initialContent);
  const conflicted = content.includes('<<<<<<< ');
  const target = path ?? name;
  const nameInvalid = path === null && BAD_NAME.test(name);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && !nameInvalid && target) {
        onSave(target, content);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onSave, target, content, nameInvalid]);

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 p-4 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-label={path ? `editing ${path}` : 'new file'}
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-rule bg-panel shadow-2xl"
        initial={{ opacity: 0, y: 14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2">
          {path !== null ? (
            <p className="min-w-0 truncate font-mono text-sm text-ink">{path}</p>
          ) : (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="filename (e.g. app.txt)"
              className="min-w-0 flex-1 rounded border border-rule bg-ground px-2 py-1 font-mono text-sm text-ink outline-none placeholder:text-ink-dim focus:border-st-head"
            />
          )}
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-ink-dim">
            editor
          </span>
        </div>

        <textarea
          autoFocus={path !== null}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="h-64 w-full resize-y bg-ground p-4 font-mono text-sm leading-relaxed text-ink outline-none"
        />

        <div className="flex items-center justify-between gap-3 border-t border-rule px-4 py-3">
          <p
            className="font-mono text-[11px]"
            style={{ color: conflicted ? 'var(--st-conflict)' : 'var(--ink-dim)' }}
          >
            {nameInvalid
              ? 'that filename will not work: no spaces, no ..'
              : conflicted
                ? 'conflict markers present: keep the lines you want, delete the <<<, ===, >>> lines'
                : 'esc to cancel · ctrl+enter to save'}
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-rule px-3 py-1.5 font-mono text-xs text-ink-dim transition-colors hover:text-ink"
            >
              cancel
            </button>
            <button
              type="button"
              disabled={nameInvalid || !target}
              onClick={() => onSave(target, content)}
              className="rounded border border-st-staged px-3 py-1.5 font-mono text-xs text-st-staged transition-colors hover:bg-st-staged/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              save
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
