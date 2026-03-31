import { describe, expect, it } from "vitest";
import { discordPcmToRealtimePcm16, ttsPcmToDiscordPcm } from "./audio-bridge.js";

describe("audio-bridge", () => {
  describe("discordPcmToRealtimePcm16", () => {
    it("returns empty buffer for empty input", () => {
      expect(discordPcmToRealtimePcm16(Buffer.alloc(0)).length).toBe(0);
    });

    it("converts 48kHz stereo PCM to 24kHz mono PCM16", () => {
      // 48kHz stereo: 4 bytes per sample (2 channels × 2 bytes)
      // 960 stereo samples = 1 frame at 48kHz (20ms)
      const stereoSamples = 960;
      const input = Buffer.alloc(stereoSamples * 4);

      // Write a 1kHz sine wave (both channels identical)
      for (let i = 0; i < stereoSamples; i++) {
        const sample = Math.round(16000 * Math.sin((2 * Math.PI * 1000 * i) / 48000));
        input.writeInt16LE(sample, i * 4); // left
        input.writeInt16LE(sample, i * 4 + 2); // right
      }

      const output = discordPcmToRealtimePcm16(input);

      // 48kHz → 24kHz = 2:1 ratio, so 960/2 = 480 samples × 2 bytes = 960 bytes
      expect(output.length).toBe(480 * 2);

      // All values should be valid 16-bit signed PCM
      for (let i = 0; i < output.length / 2; i++) {
        const sample = output.readInt16LE(i * 2);
        expect(sample).toBeGreaterThanOrEqual(-32768);
        expect(sample).toBeLessThanOrEqual(32767);
      }
    });

    it("averages stereo channels to mono", () => {
      // 2 stereo samples → 1 output sample (2:1 downsample)
      const input = Buffer.alloc(2 * 4);
      for (let i = 0; i < 2; i++) {
        input.writeInt16LE(10000, i * 4); // left = 10000
        input.writeInt16LE(-10000, i * 4 + 2); // right = -10000
      }

      const output = discordPcmToRealtimePcm16(input);
      expect(output.length).toBe(2); // 1 sample × 2 bytes
      // Average of 10000 and -10000 = 0
      expect(output.readInt16LE(0)).toBe(0);
    });
  });

  describe("ttsPcmToDiscordPcm", () => {
    it("returns empty buffer for empty input", () => {
      expect(ttsPcmToDiscordPcm(Buffer.alloc(0)).length).toBe(0);
    });

    it("converts 24kHz mono to 48kHz stereo", () => {
      // 480 mono samples at 24kHz = 20ms
      const monoSamples = 480;
      const input = Buffer.alloc(monoSamples * 2);

      for (let i = 0; i < monoSamples; i++) {
        const sample = Math.round(16000 * Math.sin((2 * Math.PI * 1000 * i) / 24000));
        input.writeInt16LE(sample, i * 2);
      }

      const output = ttsPcmToDiscordPcm(input);

      // 24kHz → 48kHz = 2:1 upsample, stereo = 4 bytes per output sample
      // 480 × 2 = 960 output samples × 4 bytes = 3840 bytes
      expect(output.length).toBe(960 * 4);
    });

    it("duplicates mono to both stereo channels", () => {
      // Single sample at value 12345
      const input = Buffer.alloc(2);
      input.writeInt16LE(12345, 0);

      const output = ttsPcmToDiscordPcm(input);

      // 1 input sample → 2 output samples (2:1 upsample), each stereo
      expect(output.length).toBe(2 * 4);

      // First output sample: both channels should match input
      expect(output.readInt16LE(0)).toBe(12345); // left
      expect(output.readInt16LE(2)).toBe(12345); // right
    });

    it("preserves signal through upsample", () => {
      // Write 10 samples with known values
      const input = Buffer.alloc(10 * 2);
      for (let i = 0; i < 10; i++) {
        input.writeInt16LE(i * 1000, i * 2);
      }

      const output = ttsPcmToDiscordPcm(input);
      expect(output.length).toBe(20 * 4);

      // Even-indexed output samples should match input exactly
      for (let i = 0; i < 10; i++) {
        const left = output.readInt16LE(i * 2 * 4);
        expect(left).toBe(i * 1000);
      }
    });
  });
});
