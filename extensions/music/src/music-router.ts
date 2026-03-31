/**
 * Music router — routes user intents to the correct backend (Lavalink or Spotify).
 */

import type { LavalinkClient } from "./lavalink-client.js";
import type { SpotifyClient } from "./spotify-client.js";
import type { GuildStateManager, MusicBackend } from "./guild-state.js";
export type { MusicBackend } from "./guild-state.js";

export type MusicAction =
  | { action: "play"; query: string; source?: MusicBackend }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "skip" }
  | { action: "queue"; query: string }
  | { action: "volume"; level: number }
  | { action: "seek"; positionMs: number }
  | { action: "status" }
  | { action: "search"; query: string }
  | { action: "switch"; backend: MusicBackend };

export type MusicResult = {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
};

export type MusicRouterDeps = {
  lavalink?: LavalinkClient;
  spotify?: SpotifyClient;
  guildState: GuildStateManager;
  getUserToken?: (discordUserId: string) => Promise<string | null>;
};

export class MusicRouter {
  private deps: MusicRouterDeps;

  constructor(deps: MusicRouterDeps) {
    this.deps = deps;
  }

  async handleAction(action: MusicAction, guildId: string, userId?: string): Promise<MusicResult> {
    switch (action.action) {
      case "play":
        return this.play(guildId, action.query, action.source, userId);
      case "pause":
        return this.pause(guildId, userId);
      case "resume":
        return this.resume(guildId, userId);
      case "skip":
        return this.skip(guildId, userId);
      case "queue":
        return this.queueTrack(guildId, action.query, userId);
      case "volume":
        return this.setVolume(guildId, action.level, userId);
      case "seek":
        return this.seek(guildId, action.positionMs);
      case "status":
        return this.getStatus(guildId, userId);
      case "search":
        return this.search(action.query);
      case "switch":
        return this.switchBackend(guildId, action.backend);
      default:
        return { success: false, message: `Unknown action: ${(action as MusicAction).action}` };
    }
  }

  private async play(guildId: string, query: string, source?: MusicBackend, userId?: string): Promise<MusicResult> {
    const backend = source ?? this.deps.guildState.get(guildId).activeBackend;

    if (backend === "spotify") {
      return this.playSpotify(guildId, query, userId);
    }
    return this.playLavalink(guildId, query);
  }

  private async playLavalink(guildId: string, query: string): Promise<MusicResult> {
    if (!this.deps.lavalink) {
      return { success: false, message: "Lavalink not configured" };
    }

    const state = this.deps.guildState.get(guildId);
    const sessionId = state.lavalinkSessionId;
    if (!sessionId) {
      return { success: false, message: "No Lavalink session. Join a voice channel first." };
    }

    // Determine search source from query context
    const source = query.toLowerCase().includes("soundcloud") ? "scsearch" as const
      : query.toLowerCase().includes("bandcamp") ? "bcsearch" as const
      : "ytsearch" as const;

    const cleanQuery = query.replace(/\b(on |from )?(soundcloud|youtube|bandcamp)\b/gi, "").trim();
    const tracks = await this.deps.lavalink.searchTracks(cleanQuery, source);
    if (tracks.length === 0) {
      return { success: false, message: `No results for "${cleanQuery}" on ${source}` };
    }

    const track = tracks[0];
    await this.deps.lavalink.play(sessionId, guildId, track);
    state.activeBackend = "lavalink";
    state.paused = false;

    return {
      success: true,
      message: `Playing: ${track.info.title} by ${track.info.author}`,
      data: { title: track.info.title, author: track.info.author, uri: track.info.uri },
    };
  }

  private async playSpotify(guildId: string, query: string, userId?: string): Promise<MusicResult> {
    if (!this.deps.spotify) {
      return { success: false, message: "Spotify not configured" };
    }

    const userToken = userId ? await this.deps.getUserToken?.(userId) : null;
    if (!userToken) {
      return { success: false, message: "No Spotify user token available. Link your account via Spoticord." };
    }

    const tracks = await this.deps.spotify.search(query, "track", 1);
    if (tracks.length === 0) {
      return { success: false, message: `No Spotify results for "${query}"` };
    }

    const track = tracks[0];
    await this.deps.spotify.play(userToken, track.uri);
    this.deps.guildState.get(guildId).activeBackend = "spotify";
    this.deps.guildState.get(guildId).paused = false;

    const artists = track.artists.map((a) => a.name).join(", ");
    return {
      success: true,
      message: `Playing on Spotify: ${track.name} by ${artists}`,
      data: { name: track.name, artists, uri: track.uri },
    };
  }

  private async pause(guildId: string, userId?: string): Promise<MusicResult> {
    const state = this.deps.guildState.get(guildId);

    if (state.activeBackend === "spotify" && this.deps.spotify) {
      const token = userId ? await this.deps.getUserToken?.(userId) : null;
      if (!token) return { success: false, message: "No Spotify token" };
      await this.deps.spotify.pause(token);
    } else if (state.activeBackend === "lavalink" && this.deps.lavalink && state.lavalinkSessionId) {
      await this.deps.lavalink.pause(state.lavalinkSessionId, guildId);
    } else {
      return { success: false, message: "No active playback" };
    }

    state.paused = true;
    return { success: true, message: "Paused" };
  }

  private async resume(guildId: string, userId?: string): Promise<MusicResult> {
    const state = this.deps.guildState.get(guildId);

    if (state.activeBackend === "spotify" && this.deps.spotify) {
      const token = userId ? await this.deps.getUserToken?.(userId) : null;
      if (!token) return { success: false, message: "No Spotify token" };
      await this.deps.spotify.play(token);
    } else if (state.activeBackend === "lavalink" && this.deps.lavalink && state.lavalinkSessionId) {
      await this.deps.lavalink.resume(state.lavalinkSessionId, guildId);
    } else {
      return { success: false, message: "No active playback" };
    }

    state.paused = false;
    return { success: true, message: "Resumed" };
  }

  private async skip(guildId: string, userId?: string): Promise<MusicResult> {
    const state = this.deps.guildState.get(guildId);

    if (state.activeBackend === "spotify" && this.deps.spotify) {
      const token = userId ? await this.deps.getUserToken?.(userId) : null;
      if (!token) return { success: false, message: "No Spotify token" };
      await this.deps.spotify.next(token);
      return { success: true, message: "Skipped to next track" };
    }

    if (state.activeBackend === "lavalink" && this.deps.lavalink && state.lavalinkSessionId) {
      const next = this.deps.guildState.shiftQueue(guildId);
      if (next) {
        await this.deps.lavalink.play(state.lavalinkSessionId, guildId, next);
        return { success: true, message: `Skipped to: ${next.info.title}` };
      }
      await this.deps.lavalink.destroyPlayer(state.lavalinkSessionId, guildId);
      return { success: true, message: "Skipped — queue empty, stopped" };
    }

    return { success: false, message: "No active playback" };
  }

  private async queueTrack(guildId: string, query: string, userId?: string): Promise<MusicResult> {
    const state = this.deps.guildState.get(guildId);

    if (state.activeBackend === "spotify" && this.deps.spotify) {
      const token = userId ? await this.deps.getUserToken?.(userId) : null;
      if (!token) return { success: false, message: "No Spotify token" };

      const tracks = await this.deps.spotify.search(query, "track", 1);
      if (tracks.length === 0) return { success: false, message: `No results for "${query}"` };

      await this.deps.spotify.queue(token, tracks[0].uri);
      return { success: true, message: `Queued: ${tracks[0].name}` };
    }

    if (this.deps.lavalink) {
      const tracks = await this.deps.lavalink.searchTracks(query);
      if (tracks.length === 0) return { success: false, message: `No results for "${query}"` };

      this.deps.guildState.addToQueue(guildId, tracks[0]);
      return {
        success: true,
        message: `Queued: ${tracks[0].info.title} (position ${state.queue.length})`,
      };
    }

    return { success: false, message: "No music backend configured" };
  }

  private async setVolume(guildId: string, level: number, userId?: string): Promise<MusicResult> {
    const state = this.deps.guildState.get(guildId);

    if (state.activeBackend === "spotify" && this.deps.spotify) {
      const token = userId ? await this.deps.getUserToken?.(userId) : null;
      if (!token) return { success: false, message: "No Spotify token" };
      await this.deps.spotify.setVolume(token, level);
    } else if (state.activeBackend === "lavalink" && this.deps.lavalink && state.lavalinkSessionId) {
      await this.deps.lavalink.setVolume(state.lavalinkSessionId, guildId, level);
    } else {
      return { success: false, message: "No active playback" };
    }

    state.volume = level;
    return { success: true, message: `Volume set to ${level}` };
  }

  private async seek(guildId: string, positionMs: number): Promise<MusicResult> {
    const state = this.deps.guildState.get(guildId);

    if (state.activeBackend === "lavalink" && this.deps.lavalink && state.lavalinkSessionId) {
      await this.deps.lavalink.seek(state.lavalinkSessionId, guildId, positionMs);
      return { success: true, message: `Seeked to ${Math.round(positionMs / 1000)}s` };
    }

    return { success: false, message: "Seek is only available for Lavalink playback" };
  }

  private async getStatus(guildId: string, userId?: string): Promise<MusicResult> {
    const state = this.deps.guildState.get(guildId);

    if (state.activeBackend === "spotify" && this.deps.spotify) {
      const token = userId ? await this.deps.getUserToken?.(userId) : null;
      if (!token) return { success: false, message: "No Spotify token" };

      const playback = await this.deps.spotify.getCurrentPlayback(token);
      if (!playback?.item) return { success: true, message: "Spotify: nothing playing" };

      const artists = playback.item.artists.map((a) => a.name).join(", ");
      const progress = Math.round(playback.progress_ms / 1000);
      const duration = Math.round(playback.item.duration_ms / 1000);
      return {
        success: true,
        message: `Spotify: ${playback.item.name} by ${artists} [${progress}s/${duration}s] ${playback.is_playing ? "▶" : "⏸"}`,
        data: { ...playback },
      };
    }

    if (state.activeBackend === "lavalink" && this.deps.lavalink && state.lavalinkSessionId) {
      const player = await this.deps.lavalink.getPlayer(state.lavalinkSessionId, guildId);
      if (!player?.track) return { success: true, message: "Lavalink: nothing playing" };

      const { title, author } = player.track.info;
      const progress = Math.round(player.state.position / 1000);
      const duration = Math.round(player.track.info.length / 1000);
      return {
        success: true,
        message: `Lavalink: ${title} by ${author} [${progress}s/${duration}s] ${player.paused ? "⏸" : "▶"}`,
        data: { track: player.track.info, paused: player.paused, volume: player.volume },
      };
    }

    return { success: true, message: "No active playback", data: { backend: state.activeBackend } };
  }

  private async search(query: string): Promise<MusicResult> {
    const results: Array<{ source: string; title: string; author: string; uri: string }> = [];

    if (this.deps.lavalink) {
      const tracks = await this.deps.lavalink.searchTracks(query, "ytsearch").catch(() => []);
      for (const t of tracks.slice(0, 3)) {
        results.push({ source: "YouTube", title: t.info.title, author: t.info.author, uri: t.info.uri });
      }
    }

    if (this.deps.spotify) {
      const tracks = await this.deps.spotify.search(query, "track", 3).catch(() => []);
      for (const t of tracks) {
        results.push({
          source: "Spotify",
          title: t.name,
          author: t.artists.map((a) => a.name).join(", "),
          uri: t.uri,
        });
      }
    }

    if (results.length === 0) {
      return { success: false, message: `No results for "${query}"` };
    }

    const formatted = results.map((r) => `[${r.source}] ${r.title} — ${r.author}`).join("\n");
    return { success: true, message: `Search results:\n${formatted}`, data: { results } };
  }

  private switchBackend(guildId: string, backend: MusicBackend): MusicResult {
    this.deps.guildState.setBackend(guildId, backend);
    return { success: true, message: `Switched to ${backend}` };
  }
}
