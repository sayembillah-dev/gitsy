import { create } from 'zustand';

/**
 * Game store. Holds the command log; the snapshot lives in GameShell state
 * (every CommandResult already carries one).
 *
 * Section 1 invariant: the persisted artifact is the command log, never repo
 * bytes. setup + commands[0..n] deterministically rebuilds any state.
 */
interface GameState {
  commandLog: string[];
  appendCommand: (command: string) => void;
  /** Replaces the log from IndexedDB on level load. */
  hydrate: (entries: string[]) => void;
  resetLog: () => void;
}

export const useGameStore = create<GameState>((set) => ({
  commandLog: [],
  appendCommand: (command) =>
    set((state) => ({ commandLog: [...state.commandLog, command] })),
  hydrate: (entries) => set({ commandLog: entries }),
  resetLog: () => set({ commandLog: [] }),
}));
