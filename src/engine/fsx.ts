// Filesystem extensions: the minimal promise-based fs surface shared by Node
// fs.promises (tests) and lightning-fs (worker), plus the recursive helpers
// both lack. Also defines EngineContext, the dependency bundle every engine
// module receives.

export interface FsLike {
  readFile(path: string, options?: { encoding?: string } | string): Promise<string | Uint8Array>;
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: string } | string,
  ): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

export interface EngineContext {
  /** Passed straight to isomorphic-git (node fs module or LightningFS instance). */
  gitFs: any;
  /** Promise-based fs for the engine's own file reads and writes. */
  fs: FsLike;
  dir: string;
  /** The simulated remote's repo directory (Phase 9). Created lazily:
   *  a level has an origin only if its setup touches one. */
  originDir: string;
  author: { name: string; email: string };
  now(): number;
}

export const joinPath = (...parts: string[]): string =>
  parts
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');

const parentOf = (path: string): string =>
  path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');

export async function pathExists(fs: FsLike, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function mkdirp(fs: FsLike, path: string): Promise<void> {
  try {
    await fs.mkdir(path);
  } catch (err: any) {
    if (err?.code === 'EEXIST') return;
    if (err?.code === 'ENOENT') {
      const parent = parentOf(path);
      if (parent && parent !== path) await mkdirp(fs, parent);
      try {
        await fs.mkdir(path);
      } catch (retry: any) {
        if (retry?.code !== 'EEXIST') throw retry;
      }
      return;
    }
    throw err;
  }
}

export async function rmrf(fs: FsLike, path: string): Promise<void> {
  if (!(await pathExists(fs, path))) return;
  const stat = await fs.stat(path);
  if (!stat.isDirectory()) {
    await fs.unlink(path);
    return;
  }
  for (const entry of await fs.readdir(path)) {
    await rmrf(fs, joinPath(path, entry));
  }
  await fs.rmdir(path);
}

export async function writeTextFile(fs: FsLike, path: string, content: string): Promise<void> {
  const parent = parentOf(path);
  if (parent) await mkdirp(fs, parent);
  await fs.writeFile(path, content, 'utf8');
}

export async function readTextFile(fs: FsLike, path: string): Promise<string> {
  const data = await fs.readFile(path, 'utf8');
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}
