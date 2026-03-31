/**
 * Spotify Web API client.
 *
 * Two auth modes:
 * - Client credentials: for public operations (search)
 * - User token: for playback control (play, pause, skip, etc.)
 */

export type SpotifyTrack = {
  id: string;
  name: string;
  uri: string;
  artists: { name: string }[];
  album: { name: string };
  duration_ms: number;
  external_urls: { spotify: string };
};

export type SpotifyDevice = {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  volume_percent: number;
};

export type SpotifyPlayback = {
  is_playing: boolean;
  progress_ms: number;
  item: SpotifyTrack | null;
  device: SpotifyDevice;
};

export type SpotifyClientConfig = {
  clientId: string;
  clientSecret: string;
};

const API_BASE = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

export class SpotifyClient {
  private clientId: string;
  private clientSecret: string;
  private clientToken: string | null = null;
  private clientTokenExpiry = 0;

  constructor(config: SpotifyClientConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
  }

  private async getClientToken(): Promise<string> {
    if (this.clientToken && Date.now() < this.clientTokenExpiry) {
      return this.clientToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!response.ok) {
      throw new Error(`Spotify client credentials auth failed: ${response.status}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.clientToken = data.access_token;
    this.clientTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return this.clientToken;
  }

  async search(query: string, type: "track" | "album" | "artist" = "track", limit = 5): Promise<SpotifyTrack[]> {
    const token = await this.getClientToken();
    const params = new URLSearchParams({ q: query, type, limit: String(limit) });
    const response = await fetch(`${API_BASE}/search?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`Spotify search failed: ${response.status}`);
    }

    const data = (await response.json()) as { tracks?: { items: SpotifyTrack[] } };
    return data.tracks?.items ?? [];
  }

  async play(userToken: string, uri?: string, deviceId?: string): Promise<void> {
    const params = deviceId ? `?device_id=${deviceId}` : "";
    const body = uri ? JSON.stringify({ uris: [uri] }) : undefined;
    const response = await fetch(`${API_BASE}/me/player/play${params}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`Spotify play failed: ${response.status}`);
    }
  }

  async pause(userToken: string): Promise<void> {
    const response = await fetch(`${API_BASE}/me/player/pause`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${userToken}` },
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`Spotify pause failed: ${response.status}`);
    }
  }

  async next(userToken: string): Promise<void> {
    const response = await fetch(`${API_BASE}/me/player/next`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`Spotify skip failed: ${response.status}`);
    }
  }

  async queue(userToken: string, uri: string): Promise<void> {
    const response = await fetch(`${API_BASE}/me/player/queue?uri=${encodeURIComponent(uri)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`Spotify queue failed: ${response.status}`);
    }
  }

  async setVolume(userToken: string, volumePercent: number): Promise<void> {
    const vol = Math.max(0, Math.min(100, Math.round(volumePercent)));
    const response = await fetch(`${API_BASE}/me/player/volume?volume_percent=${vol}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${userToken}` },
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`Spotify volume failed: ${response.status}`);
    }
  }

  async getDevices(userToken: string): Promise<SpotifyDevice[]> {
    const response = await fetch(`${API_BASE}/me/player/devices`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });

    if (!response.ok) {
      throw new Error(`Spotify devices failed: ${response.status}`);
    }

    const data = (await response.json()) as { devices: SpotifyDevice[] };
    return data.devices;
  }

  async getCurrentPlayback(userToken: string): Promise<SpotifyPlayback | null> {
    const response = await fetch(`${API_BASE}/me/player`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });

    if (response.status === 204) return null;
    if (!response.ok) {
      throw new Error(`Spotify playback failed: ${response.status}`);
    }

    return response.json() as Promise<SpotifyPlayback>;
  }

  async refreshUserToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Spotify token refresh failed: ${response.status}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    return { accessToken: data.access_token, expiresIn: data.expires_in };
  }
}
