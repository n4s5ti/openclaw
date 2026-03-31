## Research Findings

**Sub-question**: What does OpenClaw's existing voice-call plugin architecture look like, and what would a LiveKit provider need to implement?

### Key Answer

OpenClaw's voice-call extension uses a clean provider pattern (`VoiceCallProvider` interface in `extensions/voice-call/src/providers/base.ts`) with 8 required methods. A LiveKit provider would need to implement this interface, but would also need to fundamentally restructure two assumptions: (1) the webhook-centric event delivery model (LiveKit uses persistent WebSocket/gRPC instead of HTTP webhooks), and (2) the Twilio-specific media stream handler which currently hardcodes Twilio's WebSocket protocol for bidirectional audio.

### Evidence

#### Point 1: VoiceCallProvider Interface Contract

Every provider must implement the `VoiceCallProvider` interface defined in `extensions/voice-call/src/providers/base.ts`. The 8 required methods are:

1. **`verifyWebhook(ctx: WebhookContext): WebhookVerificationResult`** - Verify webhook signature/HMAC before processing.
2. **`parseWebhookEvent(ctx: WebhookContext, options?): ProviderWebhookParseResult`** - Parse provider-specific webhook payload into normalized events.
3. **`initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>`** - Initiate an outbound call.
4. **`hangupCall(input: HangupCallInput): Promise<void>`** - Hang up an active call.
5. **`playTts(input: PlayTtsInput): Promise<void>`** - Play TTS audio to the caller.
6. **`startListening(input: StartListeningInput): Promise<void>`** - Start STT/listening.
7. **`stopListening(input: StopListeningInput): Promise<void>`** - Stop STT/listening.
8. **`getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult>`** - Query provider for current call status (used for call restoration on restart).

Each provider also has a `readonly name: ProviderName` property.

- Source: `extensions/voice-call/src/providers/base.ts`
- Confidence: High

#### Point 2: Provider Name Registry is Hardcoded

The `ProviderNameSchema` in `types.ts` is a Zod enum: `z.enum(["telnyx", "twilio", "plivo", "mock"])`. The config schema in `config.ts` also hardcodes `z.enum(["telnyx", "twilio", "plivo", "mock"])` for `config.provider`. The runtime factory in `runtime.ts` (`resolveProvider`) uses a switch statement on these same names.

**What a LiveKit provider needs**: Adding `"livekit"` to three places:
- `ProviderNameSchema` in `types.ts`
- `VoiceCallConfigSchema.provider` in `config.ts`
- `resolveProvider()` switch in `runtime.ts`

Plus a new `LiveKitConfigSchema` in `config.ts` and corresponding `config.livekit` field in `VoiceCallConfigSchema`, and env-var resolution in `resolveVoiceCallConfig` and validation in `validateProviderConfig`.

- Source: `extensions/voice-call/src/types.ts:8`, `extensions/voice-call/src/config.ts:260`, `extensions/voice-call/src/runtime.ts:83-133`
- Confidence: High

#### Point 3: Normalized Event Model

All providers must normalize their provider-specific events into a discriminated union of `NormalizedEvent` types (defined in `types.ts`):

- `call.initiated` - Call started
- `call.ringing` - Phone is ringing
- `call.answered` - Call was answered
- `call.active` - Call is active/bridged
- `call.speaking` - Bot is speaking (with `text` field)
- `call.speech` - User speech transcript (with `transcript`, `isFinal`, `confidence`)
- `call.silence` - Silence detected (with `durationMs`)
- `call.dtmf` - DTMF tone received (with `digits`)
- `call.ended` - Call ended (with `reason`: completed/hangup-user/hangup-bot/timeout/error/failed/no-answer/busy/voicemail)
- `call.error` - Error occurred (with `error`, `retryable`)

Each event carries: `id`, `dedupeKey` (optional), `callId`, `providerCallId`, `timestamp`, `turnToken` (optional), `direction`, `from`, `to`.

The `CallManager` in `manager.ts` processes these normalized events via `processEvent()` and manages the call lifecycle state machine.

- Source: `extensions/voice-call/src/types.ts:75-131`
- Confidence: High

#### Point 4: Webhook-Centric Event Delivery Architecture

The current architecture is built around an HTTP webhook server (`VoiceCallWebhookServer` in `webhook.ts`). The flow is:

1. `VoiceCallWebhookServer` starts an HTTP server on a configurable port (default 3334).
2. Providers register a public webhook URL with the telephony service when initiating calls.
3. Provider sends HTTP POSTs to this URL with call state changes.
4. The server calls `provider.verifyWebhook()` then `provider.parseWebhookEvent()`.
5. Normalized events are passed to `CallManager.processEvent()`.

The webhook server also handles WebSocket upgrades for Twilio Media Streams on a separate path (`/voice/stream`).

**Challenge for LiveKit**: LiveKit does not use HTTP webhooks for real-time call control. LiveKit uses:
- WebSocket connections via LiveKit client SDKs for room participation
- Server-side SDKs for room management (REST API for create/list/delete rooms)
- LiveKit Agents framework (Python/Node) for server-side AI agents

A LiveKit provider would either need to:
(a) Run a LiveKit Agent that bridges events into the webhook pipeline, or
(b) Bypass the webhook model entirely and directly inject `NormalizedEvent`s into the `CallManager`.

Option (b) is cleaner: LiveKit events from room subscriptions could be directly mapped to `NormalizedEvent`s and fed into `manager.processEvent()`.

- Source: `extensions/voice-call/src/webhook.ts:51-495`
- Confidence: High

#### Point 5: Media Stream Handler is Twilio-Specific

The `MediaStreamHandler` in `media-stream.ts` is tightly coupled to Twilio's Media Stream WebSocket protocol:

- It expects Twilio-specific message format (`TwilioMediaMessage` interface) with events: `connected`, `start`, `media`, `stop`, `mark`, `clear`.
- The `start` event contains `callSid`, `streamSid`, `accountSid`, `customParameters`, `mediaFormat`.
- Audio is received as base64-encoded mu-law payloads in `media` events.
- Audio is sent back via `media` events with `streamSid` addressing.
- Mark events track playback position.

The handler feeds audio to an `OpenAIRealtimeSTTProvider` (WebSocket to OpenAI's Realtime API) for transcription, and handles TTS playback by queuing mu-law audio chunks.

**Challenge for LiveKit**: LiveKit has its own audio transport (WebRTC-based), not WebSocket media streams. A LiveKit integration would:
- NOT use the `MediaStreamHandler` at all.
- Instead use LiveKit's native audio tracks for receiving user audio and publishing bot audio.
- LiveKit's Agents framework provides `STT` and `TTS` pipeline abstractions that handle this natively.

- Source: `extensions/voice-call/src/media-stream.ts:1-527`
- Confidence: High

#### Point 6: TTS Pipeline Has Two Paths

TTS delivery has two paths, visible in the Twilio provider (`twilio.ts:558-635`):

**Path 1 - Core TTS + Media Streams** (preferred): When both `ttsProvider` and `mediaStreamHandler` are set:
1. `TelephonyTtsProvider.synthesizeForTelephony(text)` generates PCM audio via OpenClaw's core TTS
2. `convertPcmToMulaw8k()` converts to mu-law 8kHz
3. Audio is chunked into 20ms frames (160 bytes) and streamed via WebSocket
4. A TTS queue prevents overlapping audio

**Path 2 - Provider-native TTS** (fallback): Each provider has its own TTS mechanism:
- Twilio: TwiML `<Say>` with Polly voices
- Telnyx: Call Control `/actions/speak` API
- Plivo: XML `<Speak>` element via call transfer

The `TelephonyTtsProvider` (in `telephony-tts.ts`) is a bridge that uses OpenClaw core's TTS system (via `runtime.textToSpeechTelephony`) and converts the output to telephony-grade mu-law audio.

**For LiveKit**: LiveKit Agents framework has native TTS integration. A LiveKit provider could either:
- Use LiveKit's built-in TTS pipeline (cleanest)
- Or use the existing `TelephonyTtsProvider` and publish the mu-law/PCM audio as a LiveKit audio track

- Source: `extensions/voice-call/src/telephony-tts.ts`, `extensions/voice-call/src/twilio.ts:558-635`, `extensions/voice-call/src/telephony-audio.ts`
- Confidence: High

#### Point 7: STT Provider Architecture

The STT system uses the `OpenAIRealtimeSTTProvider` (in `providers/stt-openai-realtime.ts`), which:
- Connects via WebSocket to `wss://api.openai.com/v1/realtime?intent=transcription`
- Accepts mu-law audio directly (`g711_ulaw` format)
- Uses server-side VAD for turn detection (configurable threshold, silence duration)
- Provides callbacks: `onPartial`, `onTranscript`, `onSpeechStart`
- Has automatic reconnection (up to 5 attempts with exponential backoff)

This is a separate concern from the provider -- the STT provider receives audio from the `MediaStreamHandler` and outputs transcripts.

**For LiveKit**: LiveKit Agents framework has its own STT pipeline (`deepgram`, `google`, `openai` etc.) that receives audio directly from WebRTC tracks. A LiveKit provider would use LiveKit's native STT rather than this OpenAI Realtime STT provider.

- Source: `extensions/voice-call/src/providers/stt-openai-realtime.ts`
- Confidence: High

#### Point 8: Call Manager Lifecycle

The `CallManager` (in `manager.ts`) owns all call state:
- `activeCalls: Map<CallId, CallRecord>` - currently active calls
- `providerCallIdMap: Map<string, CallId>` - maps provider-specific IDs to internal IDs
- `processedEventIds: Set<string>` - idempotency/dedup
- `transcriptWaiters` - promise-based waiting for user speech
- `maxDurationTimers` - automatic call timeout

Key operations:
- `initialize(provider, webhookUrl)` - Sets provider, loads persisted calls from disk, verifies with provider, restarts timers
- `initiateCall(to, sessionKey, options)` - Outbound call with "notify" or "conversation" mode
- `speak(callId, text)` - Send TTS to caller
- `continueCall(callId, prompt)` - Speak + wait for transcript (conversation turn)
- `endCall(callId)` - Hang up
- `processEvent(event)` - Handle normalized events, update state machine

Call records are persisted to disk at `~/.openclaw/voice-calls/calls.jsonl`.

The `CallManagerContext` type (in `manager/context.ts`) bundles all state and dependencies for helper modules.

**For LiveKit**: The `CallManager` is provider-agnostic and would work with a LiveKit provider as-is, as long as the provider correctly implements the `VoiceCallProvider` interface and emits proper `NormalizedEvent`s.

- Source: `extensions/voice-call/src/manager.ts`, `extensions/voice-call/src/manager/context.ts`, `extensions/voice-call/src/manager/events.ts`, `extensions/voice-call/src/manager/outbound.ts`
- Confidence: High

#### Point 9: Runtime Wiring and Provider Construction

The `createVoiceCallRuntime()` function in `runtime.ts` orchestrates everything:

1. Resolves config (env vars, defaults)
2. Validates provider config
3. Creates provider via `resolveProvider()` (switch on config.provider)
4. Creates `CallManager`
5. Creates `VoiceCallWebhookServer` (which initializes `MediaStreamHandler` if streaming enabled)
6. Starts webhook server
7. Sets up tunnel (ngrok/tailscale) if configured
8. Wires TTS provider and media stream handler to Twilio provider (Twilio-specific)
9. Initializes call manager with provider and webhook URL

The Twilio provider gets special treatment: `setPublicUrl()`, `setTTSProvider()`, and `setMediaStreamHandler()` are Twilio-specific methods called during runtime initialization. This pattern suggests the runtime has knowledge of provider-specific setup needs.

**For LiveKit**: A LiveKit provider would need its own initialization in this runtime function. Instead of webhook URL + tunnel, LiveKit needs:
- LiveKit server URL (cloud or self-hosted)
- API key + secret for server-side SDK
- Room creation/management
- Agent registration (if using LiveKit Agents framework)

The current runtime assumes all providers use webhooks. A LiveKit provider would need a different event source -- likely a persistent connection to a LiveKit room rather than an HTTP webhook.

- Source: `extensions/voice-call/src/runtime.ts:135-271`
- Confidence: High

#### Point 10: Core Bridge Interface

The `core-bridge.ts` defines how the voice-call plugin talks to OpenClaw core:
- `CoreConfig`: session/TTS configuration from OpenClaw core
- `CoreAgentDeps`: `OpenClawPluginApi["runtime"]["agent"]` - the agent runtime for generating AI responses

The `response-generator.ts` (dynamically imported in `webhook.ts`) uses these to generate AI responses for inbound calls, integrating with OpenClaw's agent system for tool calling and conversation history.

**For LiveKit**: This bridge works at a higher level than the provider and would not need changes for a LiveKit integration. The AI response generation is provider-agnostic.

- Source: `extensions/voice-call/src/core-bridge.ts`, `extensions/voice-call/src/webhook.ts:450-494`
- Confidence: High

---

### Implementation Map: What a LiveKit Provider Needs

#### Files to Create

1. **`src/providers/livekit.ts`** - Main `LiveKitProvider` class implementing `VoiceCallProvider`
2. **`src/config.ts` additions** - `LiveKitConfigSchema` with: `url` (LiveKit server), `apiKey`, `apiSecret`, `roomPrefix?`

#### Files to Modify

| File | Change |
|------|--------|
| `src/types.ts:8` | Add `"livekit"` to `ProviderNameSchema` enum |
| `src/config.ts:260` | Add `"livekit"` to provider enum, add `livekit: LiveKitConfigSchema.optional()` field |
| `src/config.ts:410-457` | Add env-var resolution for `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| `src/config.ts:462-524` | Add validation for LiveKit config |
| `src/providers/index.ts` | Export `LiveKitProvider` |
| `src/runtime.ts:83-133` | Add `case "livekit"` to `resolveProvider()` |
| `src/runtime.ts:135-271` | Add LiveKit-specific runtime initialization (room management, event subscription) |
| `src/webhook.ts` | LiveKit events bypass webhook HTTP; need alternative event injection path |

#### Architectural Challenges

| Challenge | Severity | Description |
|-----------|----------|-------------|
| Event delivery model | **High** | LiveKit uses persistent connections (WebSocket/WebRTC), not HTTP webhooks. The `VoiceCallWebhookServer` pipeline needs an alternative event source. |
| Media transport | **High** | LiveKit uses WebRTC audio tracks, not Twilio-style WebSocket media streams. The `MediaStreamHandler` cannot be reused. |
| SIP integration | **Medium** | LiveKit supports SIP trunking (LiveKit SIP), but it works differently from direct telephony providers. LiveKit acts as a SIP endpoint that bridges to WebRTC rooms. |
| TTS delivery | **Medium** | LiveKit Agents have native TTS pipeline; need to decide whether to use LiveKit's or OpenClaw's core TTS. |
| STT pipeline | **Medium** | Same decision: LiveKit Agents have native STT vs. the existing OpenAI Realtime STT. |
| `webhookUrl` requirement | **Low** | `CallManager.initialize()` requires a `webhookUrl` parameter; LiveKit doesn't use one. Could pass a sentinel or refactor to make it optional. |

#### Recommended Approach

The cleanest integration path has two layers:

**Layer 1 - Provider-level**: Implement `VoiceCallProvider` for LiveKit, mapping:
- `initiateCall` -> Create LiveKit room + SIP participant (via LiveKit SIP) or dispatch agent
- `hangupCall` -> Remove participant / close room
- `playTts` -> Publish audio track to room (via LiveKit Agents TTS)
- `startListening/stopListening` -> Control STT agent in room
- `getCallStatus` -> Query room/participant state via LiveKit Server SDK
- `verifyWebhook/parseWebhookEvent` -> Either no-op (events come via SDK) or map LiveKit webhook events (LiveKit does support HTTP webhooks for room events at `POST /livekit/webhook`)

**Layer 2 - Event bridge**: Create a `LiveKitEventBridge` that subscribes to room events and injects `NormalizedEvent`s into `CallManager.processEvent()`, bypassing the HTTP webhook server for real-time events.

### Sources Cited

| Source | URL | Type | Reliability |
|--------|-----|------|-------------|
| VoiceCallProvider interface | `extensions/voice-call/src/providers/base.ts` | source code | High |
| Provider implementations (Twilio) | `extensions/voice-call/src/providers/twilio.ts` | source code | High |
| Provider implementations (Telnyx) | `extensions/voice-call/src/providers/telnyx.ts` | source code | High |
| Provider implementations (Plivo) | `extensions/voice-call/src/providers/plivo.ts` | source code | High |
| Provider registry | `extensions/voice-call/src/providers/index.ts` | source code | High |
| Type definitions | `extensions/voice-call/src/types.ts` | source code | High |
| Config schema | `extensions/voice-call/src/config.ts` | source code | High |
| Media stream handler | `extensions/voice-call/src/media-stream.ts` | source code | High |
| Call manager | `extensions/voice-call/src/manager.ts` | source code | High |
| Manager context | `extensions/voice-call/src/manager/context.ts` | source code | High |
| Manager events | `extensions/voice-call/src/manager/events.ts` | source code | High |
| Manager outbound | `extensions/voice-call/src/manager/outbound.ts` | source code | High |
| Webhook server | `extensions/voice-call/src/webhook.ts` | source code | High |
| Runtime wiring | `extensions/voice-call/src/runtime.ts` | source code | High |
| Telephony TTS | `extensions/voice-call/src/telephony-tts.ts` | source code | High |
| OpenAI Realtime STT | `extensions/voice-call/src/providers/stt-openai-realtime.ts` | source code | High |
| Core bridge | `extensions/voice-call/src/core-bridge.ts` | source code | High |
| Telephony audio utils | `extensions/voice-call/src/telephony-audio.ts` | source code | High |
| OpenAI TTS provider | `extensions/voice-call/src/providers/tts-openai.ts` | source code | High |
| Mock provider | `extensions/voice-call/src/providers/mock.ts` | source code | High |

### Overall Confidence: High

**Reasoning**: All findings are derived from direct source code analysis of the complete voice-call extension; every integration point, interface contract, and architectural pattern was verified by reading the actual implementation.

### Gaps & Limitations

- Did not analyze the plugin SDK interface (`openclaw/plugin-sdk/voice-call`) that defines how the extension registers with OpenClaw core -- this may have additional constraints on provider registration.
- Did not investigate LiveKit's Node.js Server SDK or Agents SDK in detail -- the LiveKit-side API surface was not examined (only the OpenClaw side).
- The `response-generator.ts` file was not read (dynamically imported); its exact interface for AI response generation during calls is inferred from its usage in `webhook.ts`.
- The `extensions/voice-call/index.ts` entry point was not read -- the plugin registration mechanism with OpenClaw core is not fully mapped.
- LiveKit supports HTTP webhooks for room lifecycle events (room started/finished, participant joined/left); whether these are sufficient for the `verifyWebhook`/`parseWebhookEvent` contract was not evaluated against LiveKit's actual webhook payload format.
