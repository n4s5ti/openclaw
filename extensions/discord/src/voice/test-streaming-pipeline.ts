#!/usr/bin/env -S npx tsx
/**
 * Standalone live test for the streaming voice pipeline.
 * Run: runsec npx tsx extensions/discord/src/voice/test-streaming-pipeline.ts
 */

import { discordPcmToRealtimePcm16, ttsPcmToDiscordPcm } from "./audio-bridge.js";
import { DiscordStreamingSession } from "./streaming-session.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("OPENAI_API_KEY not set. Run via: runsec npx tsx <this-file>");
  process.exit(1);
}

async function main() {
  console.log("=== Streaming Voice Pipeline Test ===\n");

  // Step 1: Generate speech via OpenAI TTS
  console.log("[1/5] Generating speech via OpenAI TTS...");
  const ttsResponse = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: "Hello, this is a test.",
      voice: "coral",
      response_format: "pcm",
      speed: 1.0,
    }),
  });

  if (!ttsResponse.ok) {
    console.error(`TTS failed: ${ttsResponse.status} ${await ttsResponse.text()}`);
    process.exit(1);
  }

  const ttsBuffer = Buffer.from(await ttsResponse.arrayBuffer());
  console.log(`   TTS: ${ttsBuffer.length} bytes (24kHz mono PCM16)`);

  // Step 2: Convert to Discord format
  console.log("[2/5] Converting to Discord format (48kHz stereo)...");
  const discordFormat = ttsPcmToDiscordPcm(ttsBuffer);
  console.log(`   Discord: ${discordFormat.length} bytes`);

  // Step 3: Connect to OpenAI Realtime STT
  console.log("[3/5] Connecting to OpenAI Realtime STT...");
  const session = new DiscordStreamingSession({
    openaiApiKey: OPENAI_KEY,
    sttModel: "gpt-4o-transcribe",
    silenceDurationMs: 500,
    vadThreshold: 0.3,
  });

  const transcriptPromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Transcript timeout (20s)")), 20_000);

    session.onSpeechStart(() => {
      console.log("   [STT] Speech started (VAD detected voice)");
    });

    session.onTranscript((text) => {
      console.log(`   [STT] Transcript: "${text}"`);
      clearTimeout(timeout);
      resolve(text);
    });
  });

  await session.start();
  console.log("   Connected!");

  // Wait for session config to be accepted
  await new Promise((r) => setTimeout(r, 500));

  // Step 4: Feed audio frame-by-frame
  console.log("[4/5] Feeding audio frame-by-frame (simulating Discord)...");
  const FRAME_SIZE = 960 * 4; // 960 stereo samples at 48kHz = 20ms
  let offset = 0;
  let frameCount = 0;

  while (offset + FRAME_SIZE <= discordFormat.length) {
    const frame = discordFormat.subarray(offset, offset + FRAME_SIZE);
    session.feedAudio(frame);
    offset += FRAME_SIZE;
    frameCount++;

    // Pace closer to real-time: ~20ms per frame, batch 5 at a time
    if (frameCount % 5 === 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  // Feed remainder
  if (offset < discordFormat.length) {
    session.feedAudio(discordFormat.subarray(offset));
    frameCount++;
  }

  // Feed 2 seconds of silence so VAD detects speech end
  console.log("   Feeding silence for VAD end-of-speech detection...");
  const silenceFrame = Buffer.alloc(FRAME_SIZE); // all zeros = silence
  for (let i = 0; i < 100; i++) { // 100 frames × 20ms = 2s of silence
    session.feedAudio(silenceFrame);
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 20));
  }

  console.log(`   Fed ${frameCount} audio frames + 100 silence frames`);

  // Step 5: Wait for transcript
  console.log("[5/5] Waiting for transcript...");
  try {
    const transcript = await transcriptPromise;
    console.log(`\n=== SUCCESS ===`);
    console.log(`Transcript: "${transcript}"`);
    await session.stop();
    process.exit(0);
  } catch (err) {
    console.error(`\n=== FAILED ===`);
    console.error(String(err));
    await session.stop();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
