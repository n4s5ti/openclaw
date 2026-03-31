/**
 * Lavalink v4 REST API client.
 *
 * Docs: https://lavalink.dev/api/rest
 * Endpoint: http://{host}:{port}/v4
 */

export type LavalinkTrackInfo = {
  identifier: string;
  title: string;
  author: string;
  length: number;
  uri: string;
  artworkUrl?: string;
  sourceName: string;
  isStream: boolean;
  isSeekable: boolean;
  position: number;
};

export type LavalinkTrack = {
  encoded: string;
  info: LavalinkTrackInfo;
};

export type LavalinkPlayerState = {
  time: number;
  position: number;
  connected: boolean;
};

export type LavalinkPlayer = {
  guildId: string;
  track: LavalinkTrack | null;
  volume: number;
  paused: boolean;
  state: LavalinkPlayerState;
};

export type LavalinkLoadResult =
  | { loadType: "track"; data: LavalinkTrack }
  | { loadType: "playlist"; data: { info: { name: string }; tracks: LavalinkTrack[] } }
  | { loadType: "search"; data: LavalinkTrack[] }
  | { loadType: "empty"; data: Record<string, never> }
  | { loadType: "error"; data: { message: string; severity: string } };

export type LavalinkConfig = {
  host: string;
  port: number;
  password: string;
};

export class LavalinkClient {
  private baseUrl: string;
  private password: string;

  constructor(config: LavalinkConfig) {
    this.baseUrl = `http://${config.host}:${config.port}/v4`;
    this.password = config.password;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.password,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Lavalink ${options.method ?? "GET"} ${path}: ${response.status} ${text}`);
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async searchTracks(
    query: string,
    source: "ytsearch" | "scsearch" | "bcsearch" = "ytsearch",
  ): Promise<LavalinkTrack[]> {
    const identifier = `${source}:${query}`;
    const result = await this.request<LavalinkLoadResult>(
      `/loadtracks?identifier=${encodeURIComponent(identifier)}`,
    );

    if (result.loadType === "search") return result.data;
    if (result.loadType === "track") return [result.data];
    if (result.loadType === "playlist") return result.data.tracks;
    if (result.loadType === "error") throw new Error(`Lavalink search error: ${result.data.message}`);
    return [];
  }

  async loadTrack(identifier: string): Promise<LavalinkLoadResult> {
    return this.request<LavalinkLoadResult>(
      `/loadtracks?identifier=${encodeURIComponent(identifier)}`,
    );
  }

  async getPlayer(sessionId: string, guildId: string): Promise<LavalinkPlayer | null> {
    try {
      return await this.request<LavalinkPlayer>(
        `/sessions/${sessionId}/players/${guildId}`,
      );
    } catch {
      return null;
    }
  }

  async updatePlayer(
    sessionId: string,
    guildId: string,
    update: {
      track?: { encoded: string };
      volume?: number;
      paused?: boolean;
      position?: number;
      endTime?: number | null;
    },
    noReplace = false,
  ): Promise<LavalinkPlayer> {
    const query = noReplace ? "?noReplace=true" : "";
    return this.request<LavalinkPlayer>(
      `/sessions/${sessionId}/players/${guildId}${query}`,
      {
        method: "PATCH",
        body: JSON.stringify(update),
      },
    );
  }

  async play(sessionId: string, guildId: string, track: LavalinkTrack): Promise<LavalinkPlayer> {
    return this.updatePlayer(sessionId, guildId, {
      track: { encoded: track.encoded },
    });
  }

  async pause(sessionId: string, guildId: string): Promise<LavalinkPlayer> {
    return this.updatePlayer(sessionId, guildId, { paused: true });
  }

  async resume(sessionId: string, guildId: string): Promise<LavalinkPlayer> {
    return this.updatePlayer(sessionId, guildId, { paused: false });
  }

  async setVolume(sessionId: string, guildId: string, volume: number): Promise<LavalinkPlayer> {
    return this.updatePlayer(sessionId, guildId, { volume: Math.max(0, Math.min(1000, volume)) });
  }

  async seek(sessionId: string, guildId: string, positionMs: number): Promise<LavalinkPlayer> {
    return this.updatePlayer(sessionId, guildId, { position: positionMs });
  }

  async destroyPlayer(sessionId: string, guildId: string): Promise<void> {
    await this.request(`/sessions/${sessionId}/players/${guildId}`, { method: "DELETE" });
  }

  async updateSession(sessionId: string, resuming = false, timeoutMs = 60_000): Promise<void> {
    await this.request(`/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ resuming, timeout: timeoutMs }),
    });
  }

  async getInfo(): Promise<{ version: { semver: string }; plugins: { name: string }[] }> {
    return this.request("/info");
  }

  async getStats(): Promise<{ players: number; playingPlayers: number; uptime: number }> {
    return this.request("/stats");
  }
}
