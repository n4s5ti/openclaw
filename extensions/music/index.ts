/**
 * OpenClaw Music Plugin — Lavalink + Spotify playback control.
 *
 * Registers:
 * - Agent tool: music_control
 * - Gateway RPC methods: music.play, music.pause, music.skip, music.status, etc.
 * - CLI: openclaw music play/pause/skip/status/...
 * - Service: lifecycle management
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseMusicConfig, type MusicConfig } from "./src/config.js";
import { LavalinkClient } from "./src/lavalink-client.js";
import { SpotifyClient } from "./src/spotify-client.js";
import { GuildStateManager } from "./src/guild-state.js";
import { MusicRouter, type MusicAction, type MusicBackend } from "./src/music-router.js";
import { MusicToolSchema, type MusicToolInput } from "./src/music-tool.js";

function createRouter(config: MusicConfig): MusicRouter {
  const lavalink = config.lavalink
    ? new LavalinkClient(config.lavalink)
    : undefined;

  const spotify =
    config.spotify?.clientId && config.spotify?.clientSecret
      ? new SpotifyClient(config.spotify)
      : undefined;

  const guildState = new GuildStateManager();

  return new MusicRouter({
    lavalink,
    spotify,
    guildState,
    // Spoticord token lookup would be wired here when spoticord config is provided
    getUserToken: undefined,
  });
}

function parseToolInput(params: MusicToolInput): MusicAction {
  switch (params.action) {
    case "play":
      return { action: "play", query: params.query ?? "", source: params.source as MusicBackend | undefined };
    case "pause":
      return { action: "pause" };
    case "resume":
      return { action: "resume" };
    case "skip":
      return { action: "skip" };
    case "queue":
      return { action: "queue", query: params.query ?? "" };
    case "volume":
      return { action: "volume", level: params.volume ?? 50 };
    case "seek":
      return { action: "seek", positionMs: (params.position_seconds ?? 0) * 1000 };
    case "status":
      return { action: "status" };
    case "search":
      return { action: "search", query: params.query ?? "" };
    case "switch":
      return { action: "switch", backend: (params.source ?? "lavalink") as MusicBackend };
    default:
      return { action: "status" };
  }
}

const plugin = {
  id: "music",
  name: "Music",
  description: "Music playback control via Lavalink (YouTube/SoundCloud) and Spotify",
  configSchema: {
    parse(value: unknown): MusicConfig {
      return parseMusicConfig(value as Record<string, unknown> | undefined);
    },
  },

  register(api: OpenClawPluginApi) {
    const config = parseMusicConfig(api.pluginConfig as Record<string, unknown> | undefined);
    if (!config.enabled) return;

    let router: MusicRouter | null = null;

    const ensureRouter = (): MusicRouter => {
      if (!router) {
        router = createRouter(config);
      }
      return router;
    };

    // Agent tool
    api.registerTool({
      name: "music_control",
      label: "Music Control",
      description:
        "Control music playback. Actions: play (query + optional source), pause, resume, skip, queue (query), volume (0-100), seek (seconds), status, search (query), switch (source: lavalink or spotify). Lavalink plays YouTube/SoundCloud/Bandcamp. Spotify plays from user's Spotify account.",
      parameters: MusicToolSchema,
      async execute(_toolCallId: string, params: MusicToolInput) {
        const action = parseToolInput(params);
        // guildId and userId would come from the session context
        const result = await ensureRouter().handleAction(action, "default");
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: result,
        };
      },
    });

    // Gateway RPC methods
    for (const method of ["play", "pause", "resume", "skip", "queue", "volume", "status", "search", "switch"] as const) {
      api.registerGatewayMethod(`music.${method}`, async ({ params, respond }) => {
        try {
          const action = parseToolInput({ action: method, ...params } as MusicToolInput);
          const guildId = (params as Record<string, unknown>)?.guildId as string | undefined ?? "default";
          const result = await ensureRouter().handleAction(action, guildId);
          respond(result.success, result);
        } catch (err) {
          respond(false, { message: String(err) });
        }
      });
    }

    // Service lifecycle
    api.registerService({
      id: "music",
      start: async () => {
        if (config.enabled) {
          ensureRouter();
          api.logger.info("Music plugin started");
        }
      },
      stop: async () => {
        router = null;
      },
    });
  },
};

export default plugin;
