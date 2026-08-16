// The package ships no types; declare the surface Gitsy uses.
declare module '@isomorphic-git/lightning-fs' {
  export default class LightningFS {
    constructor(name?: string, options?: { wipe?: boolean });
    readonly promises: {
      readFile(path: string, options?: string): Promise<string>;
      writeFile(path: string, data: string | Uint8Array, options?: string): Promise<void>;
      mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
      readdir(path: string): Promise<string[]>;
      unlink(path: string): Promise<void>;
      rmdir(path: string): Promise<void>;
      stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
    };
  }
}
