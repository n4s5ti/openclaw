/**
 * Music control agent tool definition.
 *
 * Per CLAUDE.md: no Type.Union in tool schemas, use Type.String with description for enums.
 */

import { Type } from "@sinclair/typebox";

export const MusicToolSchema = Type.Object({
  action: Type.String({
    description:
      "The music action to perform. One of: play, pause, resume, skip, queue, volume, seek, status, search, switch",
  }),
  query: Type.Optional(
    Type.String({
      description: "Search query or track name. Required for play, queue, search actions.",
    }),
  ),
  volume: Type.Optional(
    Type.Number({
      description: "Volume level 0-100. Required for volume action.",
    }),
  ),
  position_seconds: Type.Optional(
    Type.Number({
      description: "Seek position in seconds. Required for seek action.",
    }),
  ),
  source: Type.Optional(
    Type.String({
      description: "Music backend to use: lavalink (YouTube/SoundCloud/Bandcamp) or spotify. Optional for play, required for switch.",
    }),
  ),
});

export type MusicToolInput = {
  action: string;
  query?: string;
  volume?: number;
  position_seconds?: number;
  source?: string;
};
