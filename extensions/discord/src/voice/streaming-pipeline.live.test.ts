/**
 * Live integration test for the streaming voice pipeline.
 *
 * Bypasses Discord — tests the audio format bridge + OpenAI Realtime STT directly.
 * Generates speech via OpenAI TTS, converts to Discord format (48kHz stereo),
 * feeds it through discordPcmToRealtimePcm16, sends to OpenAI Realtime STT,
 * and verifies we get a transcript back.
 *
 * Requires: OPENAI_API_KEY env var (or run via runsec)
 * Run: LIVE=1 pnpm test -- extensions/discord/src/voice/streaming-pipeline.live.test.ts
 */

import { describe, expect, it } from "vitest";
import { discordPcmToRealtimePcm16, ttsPcmToDiscordPcm } from "./audio-bridge.js";
import { DiscordStreamingSession } from "./streaming-session.js";

const LIVE = process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";

describe.skipIf(!LIVE || !OPENAI_KEY)("streaming pipeline (live)", () => {
  it("round-trips: TTS → Discord format → Realtime STT → transcript", async () => {
    // Step 1: Generate speech via OpenAI TTS (24kHz mono PCM)
    const ttsResponse = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: "Hello, this is a test of the streaming voice pipeline.",
        voice: "coral",
        response_format: "pcm",
        speed: 1.0,
      }),
    });

    expect(ttsResponse.ok).toBe(true);
    const ttsBuffer = Buffer.from(await ttsResponse.arrayBuffer());
    console.log(`TTS generated: ${ttsBuffer.length} bytes (24kHz mono PCM)`);
    expect(ttsBuffer.length).toBeGreaterThan(1000);

    // Step 2: Convert to Discord format (48kHz stereo) then back to Realtime format (24kHz mono PCM16)
    // This simulates the full path: TTS → Discord playback → Discord capture → Realtime STT
    const discordFormat = ttsPcmToDiscordPcm(ttsBuffer);
    console.log(`Discord format: ${discordFormat.length} bytes (48kHz stereo PCM)`);

    const realtimeFormat = discordPcmToRealtimePcm16(discordFormat);
    console.log(`Realtime format: ${realtimeFormat.length} bytes (24kHz mono PCM16)`);

    // The round-trip should preserve roughly the same size (minus some interpolation loss)
    // Original 24kHz mono → 48kHz stereo (4x) → 24kHz mono (back to ~1x)
    expect(realtimeFormat.length).toBeGreaterThan(ttsBuffer.length * 0.8);
    expect(realtimeFormat.length).toBeLessThan(ttsBuffer.length * 1.2);

    // Step 3: Connect to OpenAI Realtime STT and feed the audio
    const session = new DiscordStreamingSession({
      openaiApiKey: OPENAI_KEY,
      sttModel: "gpt-4o-transcribe",
      silenceDurationMs: 500, // shorter for test
      vadThreshold: 0.3, // more sensitive for test
    });

    const events: string[] = [];
    let transcript = "";

    const transcriptPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Transcript timeout (15s)")), 15_000);

      session.onSpeechStart(() => {
        events.push("speech_started");
        console.log("[Test] Speech started detected by VAD");
      });

      session.onTranscript((text) => {
        events.push("transcript");
        transcript = text;
        console.log(`[Test] Transcript: "${text}"`);
        clearTimeout(timeout);
        resolve(text);
      });
    });

    await session.start();
    events.push("connected");
    console.log("[Test] Connected to OpenAI Realtime API");

    // Wait for session to be configured
    await new Promise((r) => setTimeout(r, 500));

    // Step 4: Feed audio frame-by-frame (simulating Discord's 20ms Opus frames)
    // Discord sends ~960 stereo samples per frame (20ms at 48kHz)
    // But we already converted to 24kHz mono PCM16, so feed in ~480 sample chunks
    const FRAME_SIZE = 480 * 2; // 480 samples × 2 bytes = 960 bytes per 20ms at 24kHz
    const DISCORD_FRAME_SIZE = 960 * 4; // 960 samples × 4 bytes (stereo) per 20ms at 48kHz
    let offset = 0;
    let frameCount = 0;

    // Feed the Discord-format audio frame by frame (as if coming from Discord)
    while (offset + DISCORD_FRAME_SIZE <= discordFormat.length) {
      const frame = discordFormat.subarray(offset, offset + DISCORD_FRAME_SIZE);
      session.feedAudio(frame);
      offset += DISCORD_FRAME_SIZE;
      frameCount++;

      // Simulate real-time pacing: 20ms per frame
      if (frameCount % 50 === 0) {
        await new Promise((r) => setTimeout(r, 10)); // yield occasionally
      }
    }

    // Feed remaining bytes
    if (offset < discordFormat.length) {
      session.feedAudio(discordFormat.subarray(offset));
      frameCount++;
    }

    console.log(`[Test] Fed ${frameCount} frames (${offset} bytes)`);

    // Step 5: Wait for transcript
    try {
      const result = await transcriptPromise;
      console.log(`[Test] Success! Transcript: "${result}"`);
      console.log(`[Test] Events: ${events.join(" → ")}`);

      // Verify transcript contains expected words
      const lower = result.toLowerCase();
      expect(
        lower.includes("hello") || lower.includes("test") || lower.includes("streaming") || lower.includes("voice") || lower.includes("pipeline"),
      ).toBe(true);
    } finally {
      await session.stop();
    }
  }, 30_000); // 30s timeout for the full test

  it("verifies Realtime API accepts pcm16 format and returns session events", async () => {
    const session = new DiscordStreamingSession({
      openaiApiKey: OPENAI_KEY,
    });

    await session.start();
    expect(session.isConnected()).toBe(true);

    // Feed a short burst of silence (should not trigger speech)
    const silence = Buffer.alloc(960 * 4); // 20ms of silence, 48kHz stereo
    session.feedAudio(silence);

    // Wait briefly and verify still connected
    await new Promise((r) => setTimeout(r, 1000));
    expect(session.isConnected()).toBe(true);

    await session.stop();
    expect(session.isConnected()).toBe(false);
  }, 10_000);
});
