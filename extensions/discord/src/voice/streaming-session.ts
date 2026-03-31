/**
 * Discord Streaming Voice Session
 *
 * Maintains a persistent OpenAI Realtime STT WebSocket per guild voice session.
 * Replaces the batch capture→WAV→transcribe path with streaming audio.
 *
 * Audio flow:
 *   Discord Opus → decode → 48kHz stereo PCM → audio-bridge → 8kHz mono mu-law → OpenAI Realtime
 *   OpenAI Realtime → transcript → agent → TTS → Discord playback
 *
 * Reuses OpenAIRealtimeSTTProvider pattern from voice-call extension.
 */

import WebSocket from "ws";
import { discordPcmToRealtimePcm16 } from "./audio-bridge.js";

export interface StreamingSessionConfig {
  /** OpenAI API key */
  openaiApiKey: string;
  /** STT model (default: gpt-4o-transcribe) */
  sttModel?: string;
  /** Silence duration in ms before considering speech ended (default: 800) */
  silenceDurationMs?: number;
  /** VAD threshold 0-1 (default: 0.5) */
  vadThreshold?: number;
}

type TranscriptCallback = (transcript: string) => void;
type SpeechStartCallback = () => void;

/**
 * Per-guild streaming session that bridges Discord audio to OpenAI Realtime STT.
 */
export class DiscordStreamingSession {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;

  private config: Required<StreamingSessionConfig>;
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;
  private pendingTranscript = "";

  private onTranscriptCallback: TranscriptCallback | null = null;
  private onSpeechStartCallback: SpeechStartCallback | null = null;

  constructor(config: StreamingSessionConfig) {
    this.config = {
      openaiApiKey: config.openaiApiKey,
      sttModel: config.sttModel ?? "gpt-4o-transcribe",
      silenceDurationMs: config.silenceDurationMs ?? 800,
      vadThreshold: config.vadThreshold ?? 0.5,
    };
  }

  /**
   * Connect to the OpenAI Realtime API.
   */
  async start(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  /**
   * Feed decoded Discord PCM audio (48kHz stereo 16-bit) into the STT pipeline.
   * Called per Opus frame decoded from Discord.
   */
  feedAudio(pcm48kStereo: Buffer): void {
    if (!this.connected || this.closed) return;

    // Convert Discord format → OpenAI Realtime format
    const pcm16 = discordPcmToRealtimePcm16(pcm48kStereo);
    if (pcm16.length === 0) return;

    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: pcm16.toString("base64"),
    });
  }

  /**
   * Register callback for final transcripts (after VAD detects end of speech).
   */
  onTranscript(callback: TranscriptCallback): void {
    this.onTranscriptCallback = callback;
  }

  /**
   * Register callback for speech start (VAD detected voice activity).
   * Use this for barge-in (stop current TTS playback).
   */
  onSpeechStart(callback: SpeechStartCallback): void {
    this.onSpeechStartCallback = callback;
  }

  /**
   * Gracefully close the session.
   */
  async stop(): Promise<void> {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.onTranscriptCallback = null;
    this.onSpeechStartCallback = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // --- Private ---

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = "wss://api.openai.com/v1/realtime?intent=transcription";

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.openaiApiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.on("open", () => {
        this.connected = true;
        this.reconnectAttempts = 0;

        // Configure transcription session with server-side VAD
        this.sendEvent({
          type: "transcription_session.update",
          session: {
            input_audio_format: "pcm16",
            input_audio_transcription: {
              model: this.config.sttModel,
            },
            turn_detection: {
              type: "server_vad",
              threshold: this.config.vadThreshold,
              prefix_padding_ms: 300,
              silence_duration_ms: this.config.silenceDurationMs,
            },
          },
        });

        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch {
          // Ignore parse errors
        }
      });

      this.ws.on("error", (error) => {
        if (!this.connected) {
          reject(error);
        }
      });

      this.ws.on("close", () => {
        this.connected = false;
        if (!this.closed) {
          void this.attemptReconnect();
        }
      });

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("Streaming session connection timeout"));
        }
      }, 10_000);
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) return;
    if (this.reconnectAttempts >= DiscordStreamingSession.MAX_RECONNECT_ATTEMPTS) return;

    this.reconnectAttempts++;
    const delay = DiscordStreamingSession.RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);

    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.closed) return;

    try {
      await this.doConnect();
    } catch {
      // Will retry on next close event if not maxed out
    }
  }

  private handleEvent(event: {
    type: string;
    delta?: string;
    transcript?: string;
    error?: unknown;
  }): void {
    // Debug: log all events from OpenAI Realtime API
    console.log(`[StreamingSTT] event: ${event.type}${event.error ? ` error=${JSON.stringify(event.error)}` : ""}`);

    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.pendingTranscript = "";
        this.onSpeechStartCallback?.();
        break;

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.pendingTranscript += event.delta;
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.onTranscriptCallback?.(event.transcript);
        }
        this.pendingTranscript = "";
        break;

      case "transcription_session.created":
      case "transcription_session.updated":
      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed":
        // Expected lifecycle events, no action needed
        break;

      case "error":
        // Log but don't crash — reconnect handles recovery
        break;
    }
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }
}
