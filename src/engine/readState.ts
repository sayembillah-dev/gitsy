// Reads the live repository (object store, refs, index, working tree) into a
// RawRepo for src/core/normalize.ts. This module owns every isomorphic-git
// read; core stays pure.
//
// Statuses come from CONTENT hash comparison across the three trees, never
// from statusMatrix: isomorphic-git's stat cache treats a same-size rewrite
// inside one mtime second as clean, and players hit that constantly.

import git, { STAGE, TREE } from 'isomorphic-git';
import type { RawCommit, RawRepo } from '@/core/normalize';
import type { FileEntry } from '@/core/types';
import { joinPath, pathExists, readTextFile, type EngineContext } from './fsx';

/** [path, HEAD, workdir, stage] codes, same shape as isomorphic-git's
 *  statusMatrix so executor logic mirrors real git semantics. */
export type StatusRow = [string, number, number, number];

export async function readBlobText(ctx: EngineContext, oid: string): Promise<string> {
  const { blob } = await git.readBlob({ fs: ctx.gitFs, dir: ctx.dir, oid });
  return new TextDecoder().decode(blob);
}

async function refMap(
  ctx: EngineContext,
  prefix: string,
  names: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    try {
      out[name] = await git.resolveRef({
        fs: ctx.gitFs,
        dir: ctx.dir,
        ref: `${prefix}/${name}`,
        depth: 10,
      });
    } catch {
      // skip unresolvable ref
    }
  }
  return out;
}

export async function flattenTree(ctx: EngineContext, treeOid: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (oid: string, prefix: string): Promise<void> => {
    const { tree } = await git.readTree({ fs: ctx.gitFs, dir: ctx.dir, oid });
    for (const entry of tree) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === 'tree') {
        await visit(entry.oid, path);
      } else {
        out[path] = await readBlobText(ctx, entry.oid);
      }
    }
  };
  await visit(treeOid, '');
  return out;
}

/** path to blob oid for every file in the index. */
export async function indexOids(ctx: EngineContext): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await git.walk({
    fs: ctx.gitFs,
    dir: ctx.dir,
    trees: [STAGE()],
    map: async (path: string, entries: any[]) => {
      const entry = entries?.[0];
      if (entry && (await entry.type()) === 'blob') map.set(path, await entry.oid());
      return undefined;
    },
  });
  return map;
}

/** path to blob oid for every file in HEAD's tree. Empty on an unborn branch. */
export async function headTreeOids(ctx: EngineContext): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    await git.walk({
      fs: ctx.gitFs,
      dir: ctx.dir,
      trees: [TREE({ ref: 'HEAD' })],
      map: async (path: string, entries: any[]) => {
        const entry = entries?.[0];
        if (entry && (await entry.type()) === 'blob') map.set(path, await entry.oid());
        return undefined;
      },
    });
  } catch {
    // unborn HEAD: no tree yet
  }
  return map;
}

export interface WorkdirFile {
  oid: string;
  content: string;
}

/** path to { oid, content } for every workdir file, .git excluded. */
export async function workdirFiles(ctx: EngineContext): Promise<Map<string, WorkdirFile>> {
  const out = new Map<string, WorkdirFile>();
  const visit = async (rel: string): Promise<void> => {
    const abs = rel ? joinPath(ctx.dir, rel) : ctx.dir;
    for (const name of await ctx.fs.readdir(abs)) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (childRel === '.git') continue;
      const stat = await ctx.fs.stat(joinPath(ctx.dir, childRel));
      if (stat.isDirectory()) {
        await visit(childRel);
        continue;
      }
      const content = await readTextFile(ctx.fs, joinPath(ctx.dir, childRel));
      const { oid } = await git.hashBlob({ object: new TextEncoder().encode(content) });
      out.set(childRel, { oid, content });
    }
  };
  await visit('');
  return out;
}

/**
 * Three-way compare by content hash: HEAD tree vs index vs workdir.
 * Produces the canonical statusMatrix code table:
 *   [1,1,1] clean        [1,2,1] modified unstaged   [1,2,2] modified staged
 *   [1,2,3] both         [1,0,1] deleted unstaged    [1,0,0] deleted staged
 *   [0,2,0] untracked    [0,2,2] added staged        [0,2,3] added + edited
 */
export async function statusRows(ctx: EngineContext): Promise<StatusRow[]> {
  const [headTree, index, workdir] = await Promise.all([
    headTreeOids(ctx),
    indexOids(ctx),
    workdirFiles(ctx),
  ]);
  const paths = [...new Set([...headTree.keys(), ...index.keys(), ...workdir.keys()])].sort();
  return paths.map((path) => {
    const headOid = headTree.get(path) ?? null;
    const indexOid = index.get(path) ?? null;
    const work = workdir.get(path) ?? null;
    const h = headOid !== null ? 1 : 0;
    const w = work === null ? 0 : headOid !== null && work.oid === headOid ? 1 : 2;
    const s =
      indexOid === null
        ? 0
        : headOid !== null && indexOid === headOid
          ? 1
          : work !== null && indexOid === work.oid
            ? 2
            : 3;
    return [path, h, w, s];
  });
}

/**
 * Splits status rows into the two file panels. workingTree status is the Y
 * side (workdir vs index), index status is the X side (index vs HEAD). This
 * split is what makes `reset` teachable in Phase 5.
 */
async function filePanels(
  ctx: EngineContext,
  rows: StatusRow[],
  stageOids: Map<string, string>,
  workdir: Map<string, WorkdirFile>,
  merging: boolean,
): Promise<{ workingTree: FileEntry[]; index: FileEntry[] }> {
  const workingTree: FileEntry[] = [];
  const index: FileEntry[] = [];

  for (const [path, h, w, s] of rows) {
    if (w === 0) {
      if (h === 1 || s > 0) workingTree.push({ path, status: 'deleted', content: '' });
    } else {
      const content = workdir.get(path)?.content ?? '';
      let status: FileEntry['status'] =
        h === 0 && s === 0 ? 'untracked' : w === 1 || s === 2 ? 'clean' : 'modified';
      // Mid-merge marker files surface as conflicts, not plain modifications.
      if (merging && status === 'modified' && content.includes('<<<<<<< ')) {
        status = 'conflicted';
      }
      workingTree.push({ path, status, content });
    }

    if (s === 0) {
      if (h === 1) index.push({ path, status: 'deleted', content: '' });
    } else {
      const oid = stageOids.get(path);
      const content = oid ? await readBlobText(ctx, oid) : '';
      const status: FileEntry['status'] = h === 0 || s >= 2 ? 'staged' : 'clean';
      index.push({ path, status, content });
    }
  }
  return { workingTree, index };
}

export async function readRawRepo(ctx: EngineContext): Promise<RawRepo> {
  const branches = await refMap(
    ctx,
    'refs/heads',
    await git.listBranches({ fs: ctx.gitFs, dir: ctx.dir }),
  );
  const tags = await refMap(ctx, 'refs/tags', await git.listTags({ fs: ctx.gitFs, dir: ctx.dir }));

  const headRaw = (await readTextFile(ctx.fs, joinPath(ctx.dir, '.git', 'HEAD'))).trim();
  const head = headRaw.startsWith('ref: ')
    ? { type: 'branch' as const, name: headRaw.slice(5).replace(/^refs\/heads\//, '') }
    : { type: 'detached' as const, sha: headRaw };

  const tips = new Set<string>([...Object.values(branches), ...Object.values(tags)]);
  if (head.type === 'detached') tips.add(head.sha);

  const commits = new Map<string, RawCommit>();
  for (const tip of tips) {
    let log;
    try {
      log = await git.log({ fs: ctx.gitFs, dir: ctx.dir, ref: tip });
    } catch {
      continue; // unborn or unresolvable ref
    }
    for (const entry of log) {
      if (commits.has(entry.oid)) continue;
      commits.set(entry.oid, {
        sha: entry.oid,
        message: entry.commit.message,
        parents: [...entry.commit.parent],
        tree: await flattenTree(ctx, entry.commit.tree),
      });
    }
  }

  const rows = await statusRows(ctx);
  const stageOidMap = await indexOids(ctx);
  const workdir = await workdirFiles(ctx);
  const merging = await pathExists(ctx.fs, joinPath(ctx.dir, '.git', 'MERGE_HEAD'));
  const { workingTree, index } = await filePanels(ctx, rows, stageOidMap, workdir, merging);

  return {
    commits: [...commits.values()],
    branches,
    tags,
    remoteBranches: {},
    head,
    workingTree,
    index,
  };
}
