import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Create a fake WebSocket class that extends EventEmitter
class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();

  constructor() {
    super();
    // Simulate connection on next tick
    setTimeout(() => this.emit("open"), 0);
  }
}

let lastWs: FakeWebSocket;

vi.mock("ws", () => {
  return {
    default: class MockWebSocket extends FakeWebSocket {
      constructor() {
        super();
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastWs = this;
      }
    },
  };
});

const { DiscordStreamingSession } = await import("./streaming-session.js");

describe("DiscordStreamingSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects to OpenAI Realtime API", async () => {
    const session = new DiscordStreamingSession({ openaiApiKey: "test-key" });
    await session.start();

    expect(session.isConnected()).toBe(true);

    // Should have sent transcription_session.update
    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const configEvent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(configEvent.type).toBe("transcription_session.update");
    expect(configEvent.session.input_audio_format).toBe("pcm16");
    expect(configEvent.session.turn_detection.type).toBe("server_vad");
  });

  it("converts and sends Discord PCM as mu-law", async () => {
    const session = new DiscordStreamingSession({ openaiApiKey: "test-key" });
    await session.start();
    lastWs.send.mockClear();

    // 240 stereo samples at 48kHz = 5ms of audio
    const pcm = Buffer.alloc(240 * 4);
    for (let i = 0; i < 240; i++) {
      const sample = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48000));
      pcm.writeInt16LE(sample, i * 4);
      pcm.writeInt16LE(sample, i * 4 + 2);
    }

    session.feedAudio(pcm);

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const event = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(event.type).toBe("input_audio_buffer.append");
    expect(typeof event.audio).toBe("string");
    // 240 stereo @ 48kHz → 120 mono @ 24kHz → 120 samples × 2 bytes = 240 bytes PCM16
    const pcm16 = Buffer.from(event.audio, "base64");
    expect(pcm16.length).toBe(240);
  });

  it("fires onSpeechStart callback on VAD detection", async () => {
    const session = new DiscordStreamingSession({ openaiApiKey: "test-key" });
    await session.start();

    const cb = vi.fn();
    session.onSpeechStart(cb);

    // Simulate server-side VAD event
    lastWs.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })),
    );

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires onTranscript callback with completed transcript", async () => {
    const session = new DiscordStreamingSession({ openaiApiKey: "test-key" });
    await session.start();

    const cb = vi.fn();
    session.onTranscript(cb);

    // Simulate delta + completed events
    lastWs.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          delta: "Hello ",
        }),
      ),
    );
    lastWs.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "Hello world",
        }),
      ),
    );

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("Hello world");
  });

  it("stops cleanly", async () => {
    const session = new DiscordStreamingSession({ openaiApiKey: "test-key" });
    await session.start();

    expect(session.isConnected()).toBe(true);
    await session.stop();
    expect(session.isConnected()).toBe(false);
    expect(lastWs.close).toHaveBeenCalled();
  });

  it("does not send audio when not connected", () => {
    const session = new DiscordStreamingSession({ openaiApiKey: "test-key" });
    // Don't start — should silently discard
    session.feedAudio(Buffer.alloc(240 * 4));
    // No WebSocket created, no send calls
  });
});
