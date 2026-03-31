/**
 * Per-guild music state management.
 * State is ephemeral (in-memory only, not persisted).
 */

import type { LavalinkTrack } from "./lavalink-client.js";

export type MusicBackend = "lavalink" | "spotify";

export type GuildMusicState = {
  activeBackend: MusicBackend;
  lavalinkSessionId?: string;
  queue: LavalinkTrack[];
  volume: number;
  paused: boolean;
};

export class GuildStateManager {
  private states = new Map<string, GuildMusicState>();

  get(guildId: string): GuildMusicState {
    let state = this.states.get(guildId);
    if (!state) {
      state = {
        activeBackend: "lavalink",
        queue: [],
        volume: 100,
        paused: false,
      };
      this.states.set(guildId, state);
    }
    return state;
  }

  setBackend(guildId: string, backend: MusicBackend): void {
    this.get(guildId).activeBackend = backend;
  }

  setSessionId(guildId: string, sessionId: string): void {
    this.get(guildId).lavalinkSessionId = sessionId;
  }

  addToQueue(guildId: string, track: LavalinkTrack): void {
    this.get(guildId).queue.push(track);
  }

  shiftQueue(guildId: string): LavalinkTrack | undefined {
    return this.get(guildId).queue.shift();
  }

  clearQueue(guildId: string): void {
    this.get(guildId).queue = [];
  }

  remove(guildId: string): void {
    this.states.delete(guildId);
  }

  listActive(): Array<{ guildId: string; state: GuildMusicState }> {
    return [...this.states.entries()].map(([guildId, state]) => ({ guildId, state }));
  }
}
