import { z } from "zod";

export const MusicConfigSchema = z.object({
  enabled: z.boolean().default(false),
  defaultBackend: z.enum(["lavalink", "spotify"]).default("lavalink"),
  lavalink: z
    .object({
      host: z.string().default("localhost"),
      port: z.number().default(2333),
      password: z.string().default("youshallnotpass"),
    })
    .optional(),
  spotify: z
    .object({
      clientId: z.string(),
      clientSecret: z.string(),
    })
    .optional(),
  spoticord: z
    .object({
      databaseUrl: z.string(),
    })
    .optional(),
});

export type MusicConfig = z.infer<typeof MusicConfigSchema>;

export function parseMusicConfig(raw: Record<string, unknown> | undefined): MusicConfig {
  return MusicConfigSchema.parse(raw ?? {});
}
