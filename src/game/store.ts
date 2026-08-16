import { create } from 'zustand';

/**
 * Game store. Phase 0 stub: will hold the command log, current snapshot, and
 * evaluation results once the engine lands (Phase 1+).
 *
 * Section 1 invariant: the persisted artifact is the command log, never repo
 * bytes. setup + commands[0..n] deterministically rebuilds any state.
 */
interface GameState {
  commandLog: string[];
  appendCommand: (command: string) => void;
  resetLog: () => void;
}

export const useGameStore = create<GameState>((set) => ({
  commandLog: [],
  appendCommand: (command) =>
    set((state) => ({ commandLog: [...state.commandLog, command] })),
  resetLog: () => set({ commandLog: [] }),
}));
