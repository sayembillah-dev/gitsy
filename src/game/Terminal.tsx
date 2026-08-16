'use client';

// xterm.js surface for TerminalSession. Owns the line editor (echo,
// backspace, history, tab completion) and nothing else: all game logic lives
// in terminalCore.ts so the gate can exercise it headless.

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSession } from './terminalCore';

const PROMPT = '$ ';

export default function Terminal({
  session,
  history,
  onComplete,
  onSnapshot,
  onEvaluation,
}: {
  session: TerminalSession;
  history: string[];
  onComplete?: () => void;
  onSnapshot?: (snapshot: import('@/core/types').RepoSnapshot) => void;
  onEvaluation?: (evaluation: import('@/core/types').EvaluationResult) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const completedRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'var(--font-jbmono), monospace',
      fontSize: 14,
      lineHeight: 1.35,
      cursorBlink: true,
      theme: {
        background: '#101A2B',
        foreground: '#DCE6F5',
        cursor: '#8FB8FF',
        selectionBackground: '#2A3B57',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);

    let buffer = '';
    let histIdx = history.length;
    const localHistory = [
      ...history.filter((h) => !h.startsWith('patch-answer: ') && !h.startsWith('edit-file: ')),
    ];
    let busy = false;

    const writeOut = (text: string) => {
      if (text) term.write(text.replace(/\n/g, '\r\n'));
    };
    const prompt = () => term.write('\r\n' + PROMPT);
    const redraw = (line: string) => {
      term.write('\r\x1b[2K' + PROMPT + line);
    };

    term.writeln('type "help" to see what git has unlocked so far.');

    const submit = async (line: string) => {
      busy = true;
      try {
        const r = await session.submit(line);
        if (r.clear) {
          term.clear();
        } else {
          if (r.stdout) writeOut('\r\n' + r.stdout.replace(/\n$/, ''));
          if (r.stderr) writeOut('\r\n' + r.stderr.replace(/\n$/, ''));
        }
        if (r.complete && !completedRef.current) {
          completedRef.current = true;
          term.write('\r\n');
          term.writeln('');
          term.writeln('  level complete. every goal is green.');
          onComplete?.();
        }
        if (r.snapshot) onSnapshot?.(r.snapshot);
        if (r.evaluation) onEvaluation?.(r.evaluation);
        if (line && !session.inPatch) {
          localHistory.push(line);
          histIdx = localHistory.length;
        }
      } finally {
        busy = false;
        if (!session.inPatch) prompt();
      }
    };

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        const delta = ev.key === 'ArrowUp' ? -1 : 1;
        histIdx = Math.min(Math.max(histIdx + delta, 0), localHistory.length);
        buffer = localHistory[histIdx] ?? '';
        redraw(buffer);
        return false;
      }
      return true;
    });

    const disposable = term.onData((data) => {
      if (busy) return;
      for (const ch of data) {
        if (ch === '\r') {
          const line = buffer;
          buffer = '';
          void submit(line);
          return;
        } else if (ch === '\x7f') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            term.write('\b \b');
          }
        } else if (ch === '\t') {
          const words = buffer.split(/\s+/);
          const stub = buffer.startsWith('git ') ? (words[words.length - 1] ?? '') : buffer;
          const prefixingGit = !buffer.startsWith('git ') && words.length <= 1;
          if (prefixingGit || buffer.startsWith('git ')) {
            const matches = session
              .completions()
              .filter((c) => c.startsWith(stub) && stub.length > 0);
            if (matches.length === 1) {
              const add = matches[0].slice(stub.length) + ' ';
              buffer += add;
              term.write(add);
            } else if (matches.length > 1) {
              term.write('\r\n' + matches.join('  '));
              redraw(buffer);
            }
          }
        } else if (ch === '\x1b') {
          // arrow sequences arrive as the remaining chars of `data`
        } else if (ch >= ' ') {
          buffer += ch;
          term.write(ch);
        }
      }
    });

    prompt();
    return () => {
      window.removeEventListener('resize', onResize);
      disposable.dispose();
      term.dispose();
    };
    // Session is stable per level mount; history is a snapshot at boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return <div ref={hostRef} className="h-full w-full p-3" aria-label="terminal" />;
}
