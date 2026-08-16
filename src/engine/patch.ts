// Interactive `git add -p` (BUILD-PLAN Phase 3). The engine holds one session
// at a time; the terminal drives it through engine.answer(). Staging a hunk
// means writing the intermediate content: we briefly write it to the workdir
// file, git.add it, then restore the player's bytes. Statuses are content
// hash based, so the restore leaves the observable state untouched.

import git from 'isomorphic-git';
import { applyHunks, computeHunks, type PatchHunk } from './diff';
import { joinPath, writeTextFile, type EngineContext } from './fsx';
import { headTreeOids, indexOids, readBlobText, workdirFiles } from './readState';

export const PATCH_PROMPT = '[y,n,q,a,d,/,e,?]? ';

interface PatchFile {
  path: string;
  indexOid: string | null;
  workOid: string;
  indexContent: string;
  workdirContent: string;
  hunks: PatchHunk[];
}

export interface PatchSession {
  files: PatchFile[];
  fileIdx: number;
  hunkIdx: number;
  /** accepted[fileIdx][hunkIdx] */
  accepted: boolean[][];
}

export interface PatchStep {
  text: string;
  done: boolean;
}

/** Collects tracked files whose workdir differs from the index. */
export async function startPatch(
  ctx: EngineContext,
  paths: string[],
): Promise<{ session: PatchSession | null; out: string }> {
  const wanted = paths.filter((p) => p !== '.').map((p) => p.replace(/^\.\//, ''));
  const [headTree, index, workdir] = await Promise.all([
    headTreeOids(ctx),
    indexOids(ctx),
    workdirFiles(ctx),
  ]);
  const files: PatchFile[] = [];
  for (const [path, work] of [...workdir.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const indexOid = index.get(path) ?? null;
    const headOid = headTree.get(path) ?? null;
    if (indexOid === null && headOid === null) continue; // untracked: real add -p skips
    if (indexOid !== null && indexOid === work.oid) continue; // already staged as-is
    if (wanted.length > 0 && !wanted.includes(path)) continue;
    const baseOid = indexOid ?? headOid;
    const indexContent = baseOid ? await readBlobText(ctx, baseOid) : '';
    const hunks = computeHunks(indexContent, work.content);
    if (hunks.length > 0) {
      files.push({
        path,
        indexOid: baseOid,
        workOid: work.oid,
        indexContent,
        workdirContent: work.content,
        hunks,
      });
    }
  }
  if (files.length === 0) return { session: null, out: '' };
  const session: PatchSession = {
    files,
    fileIdx: 0,
    hunkIdx: 0,
    accepted: files.map((f) => f.hunks.map(() => false)),
  };
  return { session, out: renderCurrent(session) };
}

function renderCurrent(s: PatchSession): string {
  const f = s.files[s.fileIdx];
  const h = f.hunks[s.hunkIdx];
  let text = '';
  if (s.hunkIdx === 0) {
    const short = (oid: string | null) => (oid ? oid.slice(0, 7) : '0000000');
    text +=
      `diff --git a/${f.path} b/${f.path}\n` +
      `index ${short(f.indexOid)}..${short(f.workOid)} 100644\n` +
      `--- a/${f.path}\n+++ b/${f.path}\n`;
  }
  return text + h.header + '\n' + h.lines.join('\n') + '\nStage this hunk ' + PATCH_PROMPT;
}

/** Returns true when the session is exhausted. */
function advance(s: PatchSession): boolean {
  s.hunkIdx += 1;
  while (s.fileIdx < s.files.length && s.hunkIdx >= s.files[s.fileIdx].hunks.length) {
    s.fileIdx += 1;
    s.hunkIdx = 0;
  }
  return s.fileIdx >= s.files.length;
}

async function applyAccepted(ctx: EngineContext, s: PatchSession): Promise<void> {
  for (let i = 0; i < s.files.length; i++) {
    const f = s.files[i];
    const picked = f.hunks.filter((_, k) => s.accepted[i][k]);
    if (picked.length === 0) continue;
    const staged = applyHunks(f.indexContent, picked);
    if (staged !== f.workdirContent) {
      await writeTextFile(ctx.fs, joinPath(ctx.dir, f.path), staged);
    }
    await git.add({ fs: ctx.gitFs, dir: ctx.dir, filepath: f.path });
    if (staged !== f.workdirContent) {
      await writeTextFile(ctx.fs, joinPath(ctx.dir, f.path), f.workdirContent);
    }
  }
}

const HELP_TEXT =
  'y - stage this hunk\n' +
  'n - do not stage this hunk\n' +
  'q - quit; do not stage this hunk or any of the remaining ones\n' +
  'a - stage this hunk and all later hunks in the file\n' +
  'd - do not stage this hunk or any of the later hunks in the file\n';

export async function answerPatch(
  ctx: EngineContext,
  s: PatchSession,
  input: string,
): Promise<PatchStep> {
  const a = input.trim().charAt(0).toLowerCase();
  if (a === '?') return { text: HELP_TEXT + renderCurrent(s), done: false };
  if (a === 's') return { text: 'Sorry, cannot split this hunk\n' + renderCurrent(s), done: false };
  if (a === 'e') {
    return { text: 'Manual hunk edit is not available in Gitsy\n' + renderCurrent(s), done: false };
  }
  if (a === 'q') {
    await applyAccepted(ctx, s);
    return { text: '', done: true };
  }
  if (a === 'y') {
    s.accepted[s.fileIdx][s.hunkIdx] = true;
  } else if (a === 'a') {
    const f = s.files[s.fileIdx];
    for (let k = s.hunkIdx; k < f.hunks.length; k++) s.accepted[s.fileIdx][k] = true;
    s.hunkIdx = f.hunks.length - 1;
  } else if (a === 'd') {
    s.hunkIdx = s.files[s.fileIdx].hunks.length - 1;
  } else if (a !== 'n') {
    return { text: renderCurrent(s), done: false }; // unknown key: re-prompt
  }
  if (advance(s)) {
    await applyAccepted(ctx, s);
    return { text: '', done: true };
  }
  return { text: renderCurrent(s), done: false };
}
