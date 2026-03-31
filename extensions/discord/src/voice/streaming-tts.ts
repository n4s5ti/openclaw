/**
 * Streaming TTS playback for Discord voice.
 *
 * Calls OpenAI TTS API, converts 24kHz mono PCM → 48kHz stereo PCM,
 * and streams to a Discord AudioPlayer via createAudioResource.
 */

import { Readable } from "node:stream";
import { AudioPlayerStatus, StreamType, createAudioResource, entersState } from "@discordjs/voice";
import type { AudioPlayer } from "@discordjs/voice";
import { ttsPcmToDiscordPcm } from "./audio-bridge.js";

const PLAYBACK_TIMEOUT_MS = 15_000;
const SPEAKING_TIMEOUT_MS = 60_000;

export interface StreamingTtsConfig {
  apiKey: string;
  model?: string;
  voice?: string;
  speed?: number;
  instructions?: string;
}

/**
 * Synthesize text and play it on a Discord AudioPlayer.
 *
 * Returns a promise that resolves when playback completes.
 * Pass an AbortSignal to support barge-in (stops playback mid-speech).
 */
export async function playStreamingTts(params: {
  text: string;
  player: AudioPlayer;
  config: StreamingTtsConfig;
  signal?: AbortSignal;
}): Promise<void> {
  const { text, player, config, signal } = params;

  if (signal?.aborted) return;

  // Generate PCM from OpenAI TTS (24kHz mono 16-bit)
  const body: Record<string, unknown> = {
    model: config.model ?? "gpt-4o-mini-tts",
    input: text,
    voice: config.voice ?? "coral",
    response_format: "pcm",
    speed: config.speed ?? 1.0,
  };
  if (config.instructions) {
    body.instructions = config.instructions;
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI TTS failed: ${response.status} - ${error}`);
  }

  if (signal?.aborted) return;

  const arrayBuffer = await response.arrayBuffer();
  const pcm24k = Buffer.from(arrayBuffer);

  if (signal?.aborted) return;

  // Convert to Discord format: 48kHz stereo 16-bit PCM
  const pcm48kStereo = ttsPcmToDiscordPcm(pcm24k);

  // Create a readable stream from the buffer
  const stream = new Readable({
    read() {
      this.push(pcm48kStereo);
      this.push(null);
    },
  });

  const resource = createAudioResource(stream, {
    inputType: StreamType.Raw,
    inlineVolume: false,
  });

  // Handle barge-in: stop playback if signal fires
  const abortHandler = () => {
    player.stop(true);
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, PLAYBACK_TIMEOUT_MS).catch(() => undefined);
    if (signal?.aborted) return;
    await entersState(player, AudioPlayerStatus.Idle, SPEAKING_TIMEOUT_MS).catch(() => undefined);
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }
}
