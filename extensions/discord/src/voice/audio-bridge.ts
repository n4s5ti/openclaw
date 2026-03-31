/**
 * Audio format bridge between Discord voice and OpenAI Realtime API.
 *
 * Discord provides: 48kHz stereo 16-bit PCM (from Opus decoding)
 * OpenAI Realtime expects: 24kHz mono 16-bit PCM (pcm16 format)
 * OpenAI TTS returns: 24kHz mono 16-bit PCM
 */

const DISCORD_SAMPLE_RATE = 48_000;
const REALTIME_SAMPLE_RATE = 24_000;

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

/**
 * Convert 48kHz stereo 16-bit PCM to 24kHz mono 16-bit PCM for OpenAI Realtime STT.
 *
 * Steps: stereo→mono (average channels), 48kHz→24kHz (2:1 downsample with linear interpolation).
 * Output: 24kHz mono 16-bit PCM little-endian — matches OpenAI Realtime "pcm16" format.
 */
export function discordPcmToRealtimePcm16(pcm48kStereo: Buffer): Buffer {
  const stereoSamples = Math.floor(pcm48kStereo.length / 4); // 2 bytes × 2 channels
  if (stereoSamples === 0) return Buffer.alloc(0);

  // Stereo to mono: average left + right channels
  const mono48k = Buffer.alloc(stereoSamples * 2);
  for (let i = 0; i < stereoSamples; i++) {
    const left = pcm48kStereo.readInt16LE(i * 4);
    const right = pcm48kStereo.readInt16LE(i * 4 + 2);
    mono48k.writeInt16LE(clamp16(Math.round((left + right) / 2)), i * 2);
  }

  // Downsample 48kHz → 24kHz (2:1 ratio) using linear interpolation
  const ratio = DISCORD_SAMPLE_RATE / REALTIME_SAMPLE_RATE;
  const outputSamples = Math.floor(stereoSamples / ratio);
  const pcm24k = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = mono48k.readInt16LE(srcIndex * 2);
    const s1Index = Math.min(srcIndex + 1, stereoSamples - 1);
    const s1 = mono48k.readInt16LE(s1Index * 2);

    pcm24k.writeInt16LE(clamp16(Math.round(s0 + frac * (s1 - s0))), i * 2);
  }

  return pcm24k;
}

/**
 * Convert 24kHz mono 16-bit PCM (from OpenAI TTS) to 48kHz stereo 16-bit PCM for Discord.
 *
 * Steps: 24kHz→48kHz (2:1 upsample with linear interpolation), mono→stereo (duplicate).
 */
export function ttsPcmToDiscordPcm(pcm24kMono: Buffer): Buffer {
  const inputSamples = Math.floor(pcm24kMono.length / 2);
  if (inputSamples === 0) return Buffer.alloc(0);

  // Upsample 24kHz → 48kHz (2:1 ratio) with linear interpolation
  const outputSamples = inputSamples * 2;
  const pcm48kStereo = Buffer.alloc(outputSamples * 4); // 2 bytes × 2 channels

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i / 2;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = pcm24kMono.readInt16LE(srcIndex * 2);
    const s1Index = Math.min(srcIndex + 1, inputSamples - 1);
    const s1 = pcm24kMono.readInt16LE(s1Index * 2);

    const sample = clamp16(Math.round(s0 + frac * (s1 - s0)));
    // Write to both left and right channels
    pcm48kStereo.writeInt16LE(sample, i * 4);
    pcm48kStereo.writeInt16LE(sample, i * 4 + 2);
  }

  return pcm48kStereo;
}
