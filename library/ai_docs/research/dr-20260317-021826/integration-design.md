## Research Findings

**Sub-question**: How would a LiveKit integration fit into OpenClaw's voice system architecture?

### Key Answer

LiveKit cannot cleanly fit as another telephony provider alongside Twilio/Telnyx/Plivo because its architecture is fundamentally different (room-based agent dispatch vs. webhook-driven telephony). It would require either a separate plugin (`extensions/livekit-voice/`) or a significant expansion of the voice-call extension to support a second inbound model, but LiveKit's built-in SIP bridge could potentially replace the current telephony providers entirely while also enabling WebRTC browser voice and acting as a unified media backend for Discord voice.

### Evidence

#### Point 1: Current Provider Interface Is Telephony-Specific

The `VoiceCallProvider` interface at `extensions/voice-call/src/providers/base.ts` is designed around telephony webhook patterns. It requires:
- `verifyWebhook(ctx: WebhookContext)` -- validates webhook signatures from telephony providers
- `parseWebhookEvent(ctx: WebhookContext)` -- parses provider-specific HTTP POST payloads into normalized events
- `initiateCall(input: InitiateCallInput)` -- expects `from`/`to` phone numbers (E.164) and a `webhookUrl`
- `hangupCall`, `playTts`, `startListening`, `stopListening` -- all map to telephony REST API calls

LiveKit has none of these concepts. There are no webhooks to verify, no phone numbers in the call initiation path (unless SIP is involved), and media control happens through WebRTC tracks not REST APIs. A LiveKit integration cannot implement this interface without extensive adaptation/no-ops.

The `ProviderName` enum in `extensions/voice-call/src/types.ts` (line 8) is currently `z.enum(["telnyx", "twilio", "plivo", "mock"])` -- adding "livekit" here would be misleading since LiveKit does not behave like these providers.
- Source: `extensions/voice-call/src/providers/base.ts`, `extensions/voice-call/src/types.ts`
- Confidence: High

#### Point 2: Inbound Model Is Fundamentally Different

**Current telephony model**: Telephony provider calls a webhook URL -> `VoiceCallWebhookServer` at `extensions/voice-call/src/webhook.ts` receives HTTP POST -> verifies signature -> parses into `NormalizedEvent` -> `CallManager.processEvent()` -> state machine transitions.

**LiveKit model**: A worker process maintains a WebSocket connection to LiveKit server. When a room is created (or a SIP call arrives), the server dispatches a "job" to the worker. The worker accepts the job, joins the room as a participant, and subscribes to audio/video tracks. There is no webhook URL, no HTTP POST, no signature verification.

Reconciliation options:
1. **Adapter pattern**: A LiveKit worker process runs alongside the webhook server. When it receives a job, it synthesizes `NormalizedEvent` objects (e.g., `call.initiated`, `call.answered`, `call.speech`, `call.ended`) and feeds them into the existing `CallManager.processEvent()` pipeline. The `CallRecord` would use the LiveKit room name or participant identity as `providerCallId`.
2. **Separate plugin**: A dedicated `extensions/livekit-voice/` plugin that has its own lifecycle manager, bypassing the webhook/telephony model entirely.
3. **LiveKit SIP bridge**: Use LiveKit's built-in SIP support to bridge telephony calls into LiveKit rooms. This means LiveKit replaces Twilio/Telnyx/Plivo at the telephony layer, and the agent worker handles both SIP-bridged calls and WebRTC calls uniformly. This is the most architecturally clean option.
- Source: `extensions/voice-call/src/webhook.ts`, https://docs.livekit.io/agents/overview/, https://docs.livekit.io/agents/start/telephony/
- Confidence: High

#### Point 3: Media Pipeline Requires a New Abstraction Layer

The current media pipeline is tightly coupled to Twilio's WebSocket media stream format:
- `MediaStreamHandler` at `extensions/voice-call/src/media-stream.ts` receives Twilio-specific JSON messages (`event: "connected" | "start" | "media" | "stop"`)
- Audio arrives as base64-encoded mu-law (G.711) at 8kHz mono via the `TwilioMediaMessage` interface
- STT uses `OpenAIRealtimeSTTProvider` which connects to OpenAI's WebSocket API and sends G.711 mu-law audio
- TTS output goes through `TelephonyTtsProvider.synthesizeForTelephony()` which converts PCM to mu-law 8kHz

LiveKit's media pipeline is entirely different:
- Audio arrives as WebRTC tracks (typically Opus codec at 48kHz)
- The LiveKit Agents SDK provides its own STT/TTS/LLM pipeline through `AgentSession` with pluggable providers (including OpenAI)
- The `VoicePipelineAgent` handles VAD, STT, LLM orchestration, TTS, and barge-in natively
- Audio is published back as WebRTC tracks, not WebSocket JSON messages

**Design implication**: If LiveKit is added, the `MediaStreamHandler` class would NOT be reused. Instead, either:
- LiveKit's own `AgentSession`/`VoicePipelineAgent` handles the full pipeline (preferred -- leverages LiveKit's battle-tested turn detection and interruption handling)
- A custom adapter extracts raw audio from LiveKit tracks and feeds it into the existing OpenAI Realtime STT pipeline (complex, loses LiveKit's built-in pipeline advantages)
- Source: `extensions/voice-call/src/media-stream.ts`, `extensions/voice-call/src/providers/stt-openai-realtime.ts`, https://docs.livekit.io/agents/build/audio/, https://github.com/livekit/agents-js
- Confidence: High

#### Point 4: Call Lifecycle Mapping Is Possible but Requires Translation

Current lifecycle (`extensions/voice-call/src/types.ts` `CallStateSchema`):
```
initiated -> ringing -> answered -> active -> speaking/listening -> completed/hangup-user/hangup-bot/timeout/error
```

LiveKit lifecycle:
```
room created -> agent dispatched -> agent joins room -> participant joins -> audio tracks published -> participant leaves -> room closes
```

Mapping:
| Current State | LiveKit Equivalent |
|---|---|
| `initiated` | Room created / `CreateSIPParticipant` called |
| `ringing` | SIP INVITE sent (SIP only) / waiting for participant |
| `answered` | Participant joined room, audio tracks published |
| `active` | Agent subscribed to participant tracks, processing |
| `speaking` | Agent publishing TTS audio track |
| `listening` | Agent subscribed to participant audio, VAD active |
| `completed` | Room closed normally |
| `hangup-user` | Participant left room |
| `hangup-bot` | Agent disconnected from room |
| `timeout` | No participant joined within timeout / room idle timeout |

The `CallRecord` schema could be reused with:
- `providerCallId` = LiveKit room name or SIP participant ID
- `from` = participant identity or SIP caller number
- `to` = room name or SIP callee number
- `provider` = "livekit" (new enum value)

The `NormalizedEvent` discriminated union could accommodate LiveKit events by mapping:
- Room participant connected -> `call.answered`
- Speech detected (VAD) -> `call.speech`
- Participant disconnected -> `call.ended`
- Source: `extensions/voice-call/src/types.ts`, https://docs.livekit.io/reference/telephony/sip-participant/
- Confidence: Medium

#### Point 5: Secrets Configuration Maps Cleanly

LiveKit requires three secrets: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`.

These map directly to OpenClaw's secrets framework:

**1Password (exec provider via `openclaw-op-resolver`)**:
```
op://shared.dev/LIVEKIT_API_KEY/credential
op://shared.dev/LIVEKIT_API_SECRET/credential
op://shared.dev/LIVEKIT_URL/credential
```

**OpenClaw config (`openclaw.json`)**:
```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "config": {
          "livekit": {
            "apiKey": { "source": "env", "provider": "default", "id": "LIVEKIT_API_KEY" },
            "apiSecret": { "source": "env", "provider": "default", "id": "LIVEKIT_API_SECRET" },
            "url": { "source": "env", "provider": "default", "id": "LIVEKIT_URL" }
          }
        }
      }
    }
  }
}
```

Or as a separate plugin:
```json
{
  "plugins": {
    "entries": {
      "livekit-voice": {
        "config": {
          "apiKey": { "source": "exec", "provider": "op", "id": "LIVEKIT_API_KEY" },
          "apiSecret": { "source": "exec", "provider": "op", "id": "LIVEKIT_API_SECRET" },
          "url": "wss://my-project.livekit.cloud"
        }
      }
    }
  }
}
```

The `SecretInput` type (`src/config/types.secrets.ts`) supports `string | SecretRef`, so LiveKit secrets can be either plain strings, env var refs (`${LIVEKIT_API_KEY}`), or structured `SecretRef` objects with `source`/`provider`/`id`.

**secrets.env additions**:
```
LIVEKIT_API_KEY=<key>
LIVEKIT_API_SECRET=<secret>
LIVEKIT_URL=wss://my-project.livekit.cloud
```
- Source: `src/config/types.secrets.ts`, https://docs.livekit.io/deploy/agents/secrets/
- Confidence: High

#### Point 6: Discord Voice Could Use LiveKit as Media Backend (Feasible but Non-Trivial)

OpenClaw's Discord voice system (`extensions/discord/src/voice/manager.ts`) currently uses `@discordjs/voice` directly:
- Joins voice channels via `joinVoiceChannel()` from `@discordjs/voice`
- Receives Opus audio via `connection.receiver.subscribe()` with `EndBehaviorType.AfterSilence`
- Decodes Opus to PCM using `opusscript`
- Writes WAV files, transcribes via the media-understanding runner
- Generates response text via `agentCommandFromIngress()`
- Synthesizes TTS audio via OpenClaw's core TTS system
- Plays back via `createAudioPlayer()` / `createAudioResource()`

The pipeline is: Opus decode -> WAV file -> transcription API -> agent -> TTS -> audio file -> Discord audio player.

LiveKit could theoretically replace this pipeline by:
1. Bridging Discord voice to a LiveKit room (Discord bot receives audio -> publishes to LiveKit room -> LiveKit agent processes)
2. Using LiveKit's agent pipeline for STT/LLM/TTS instead of the manual decode/file/transcribe/TTS cycle
3. Publishing the agent's response audio back to the Discord voice channel

However, this would be complex because:
- Discord voice uses its own gateway protocol (not standard WebRTC/SIP)
- The `@discordjs/voice` library handles Discord's proprietary voice connection, DAVE encryption, etc.
- There is no standard way to bridge Discord voice channels into LiveKit rooms without custom audio forwarding code
- The current approach works and is already battle-tested with DAVE encryption handling and decrypt failure recovery

**Verdict**: Possible as a future optimization but not a natural fit. The current direct `@discordjs/voice` integration is simpler and more reliable for Discord-specific voice.
- Source: `extensions/discord/src/voice/manager.ts`
- Confidence: Medium

#### Point 7: Web UI Voice via LiveKit Is the Most Natural Integration Point

OpenClaw has a web provider (`src/gateway/server-methods/web.ts`) but currently no browser-based voice chat capability. LiveKit is purpose-built for this:

1. **Browser client**: LiveKit provides `livekit-client` JS SDK that handles WebRTC room connection, microphone capture, and audio playback with a few lines of code
2. **Token generation**: The OpenClaw gateway would generate LiveKit access tokens (using `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`) and pass them to the browser client
3. **Agent backend**: A LiveKit agent worker (using `@livekit/agents`) would join the room, process speech, and respond -- this is LiveKit's primary use case

Architecture:
```
Browser (livekit-client SDK)
  -> WebRTC tracks -> LiveKit Server (Cloud or self-hosted)
  -> Agent worker (@livekit/agents, VoicePipelineAgent)
  -> STT -> LLM (via OpenClaw agent system) -> TTS
  -> WebRTC tracks back to browser
```

The OpenClaw web gateway would need:
- A new endpoint to create LiveKit rooms and generate tokens
- A LiveKit agent worker process that bridges to OpenClaw's agent system (`agentCommandFromIngress` or similar)
- Frontend integration in the web UI to add a "voice chat" button that connects via `livekit-client`

This is the highest-value LiveKit integration point because it enables a capability OpenClaw currently lacks entirely (browser voice chat).
- Source: https://github.com/livekit/client-sdk-js, https://docs.livekit.io/intro/basics/connect/
- Confidence: High

#### Point 8: Recommended Architecture -- Separate Plugin with SIP Bridge Option

Based on the analysis, the recommended integration approach is:

**Option A: Separate `extensions/livekit-voice/` plugin** (recommended for initial implementation)
- Does not modify the existing telephony voice-call extension
- Registers its own `registerService` for the LiveKit agent worker lifecycle
- Registers gateway methods like `livekit.createRoom`, `livekit.token`
- Uses `@livekit/agents` and `@livekit/agents-plugin-openai` (or similar) for the voice pipeline
- Bridges to OpenClaw's agent system for LLM responses
- Enables web UI voice chat as primary use case

**Option B: Expand voice-call with LiveKit SIP bridge** (recommended for telephony convergence)
- Use LiveKit's SIP trunk support to replace Twilio/Telnyx/Plivo
- Configure a LiveKit SIP trunk pointed at Twilio/Telnyx SIP endpoints
- Inbound calls arrive as SIP participants in LiveKit rooms
- Outbound calls use `CreateSIPParticipant` API
- The LiveKit agent worker handles all voice pipeline concerns
- Eliminates the need for webhook servers, tunnel configuration, media stream WebSocket handling
- Significantly simplifies the architecture at the cost of requiring a LiveKit server (Cloud or self-hosted)

**Option C: Hybrid** (long-term)
- Start with Option A for web voice
- Add SIP bridge support to Option A for telephony
- Deprecate direct telephony providers over time as LiveKit SIP matures

Key code touchpoints for Option A:
- New `extensions/livekit-voice/index.ts` -- plugin entry, registers service/tools/gateway methods
- New `extensions/livekit-voice/src/worker.ts` -- LiveKit agent worker using `@livekit/agents`
- New `extensions/livekit-voice/src/config.ts` -- Zod schema for LiveKit config (apiKey, apiSecret, url)
- `extensions/livekit-voice/package.json` -- deps: `@livekit/agents`, `livekit-server-sdk`
- Gateway method for token generation: `livekit.connect` -> returns `{ token, url }` for browser client
- Source: Architecture analysis based on codebase and LiveKit docs
- Confidence: Medium

### Sources Cited

| Source | URL | Type | Reliability |
|--------|-----|------|-------------|
| LiveKit Agents Docs | https://docs.livekit.io/agents/ | official | High |
| LiveKit Agents JS SDK | https://github.com/livekit/agents-js | official | High |
| LiveKit Telephony/SIP Docs | https://docs.livekit.io/agents/start/telephony/ | official | High |
| LiveKit SIP API Reference | https://docs.livekit.io/reference/telephony/sip-api/ | official | High |
| LiveKit Client SDK JS | https://github.com/livekit/client-sdk-js | official | High |
| LiveKit Secrets Management | https://docs.livekit.io/deploy/agents/secrets/ | official | High |
| LiveKit Agent Dispatch | https://docs.livekit.io/agents/server/agent-dispatch/ | official | High |
| LiveKit Voice Pipeline Agent Node Example | https://github.com/livekit-examples/voice-pipeline-agent-node | official | High |
| OpenClaw voice-call provider interface | `extensions/voice-call/src/providers/base.ts` | codebase | High |
| OpenClaw media stream handler | `extensions/voice-call/src/media-stream.ts` | codebase | High |
| OpenClaw voice-call types/lifecycle | `extensions/voice-call/src/types.ts` | codebase | High |
| OpenClaw voice-call config schema | `extensions/voice-call/src/config.ts` | codebase | High |
| OpenClaw voice-call runtime | `extensions/voice-call/src/runtime.ts` | codebase | High |
| OpenClaw webhook server | `extensions/voice-call/src/webhook.ts` | codebase | High |
| OpenClaw Discord voice manager | `extensions/discord/src/voice/manager.ts` | codebase | High |
| OpenClaw secrets types | `src/config/types.secrets.ts` | codebase | High |
| OpenClaw Discord voice config | `src/config/types.discord.ts` | codebase | High |

### Overall Confidence: High

**Reasoning**: Analysis is grounded in direct codebase reading of all relevant OpenClaw files (provider interfaces, media pipeline, call lifecycle types, config schemas, Discord voice, secrets framework) cross-referenced with official LiveKit documentation for the agents SDK, SIP bridge, and client SDK patterns.

### Gaps & Limitations
- Did not inspect the full LiveKit agents-js source code to verify exact TypeScript API surface for `AgentSession`, `VoicePipelineAgent`, and `defineAgent`; relied on docs and examples
- LiveKit Cloud pricing and self-hosting operational requirements were not researched (may affect feasibility)
- Did not verify whether `@livekit/agents` has a stable Node.js release or is still in beta (the Python SDK is more mature)
- The OpenClaw web provider frontend code was not found in the repo (may live elsewhere); cannot confirm exact integration points for browser voice UI
- Did not research latency characteristics of LiveKit's SIP bridge vs. direct Twilio/Telnyx WebSocket streams
- The `talk-voice` extension (`extensions/talk-voice/index.ts`) is a thin ElevenLabs voice picker command; it is unrelated to the voice pipeline architecture but confirms OpenClaw has multiple voice-adjacent features to coordinate
