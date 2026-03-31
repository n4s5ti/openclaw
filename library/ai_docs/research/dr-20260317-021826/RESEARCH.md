# LiveKit Integration Research for OpenClaw

**Date**: 2026-03-17
**Researchers**: 4 parallel agents (SDK architecture, OpenClaw voice architecture, infrastructure/deployment, integration design)
**Overall Confidence**: High (all core findings sourced from official LiveKit docs and direct codebase analysis)

---

## 1. Executive Summary

LiveKit is a WebRTC-based real-time communication platform with a mature Agents SDK (Node.js 1.0 stable) that provides voice AI pipeline orchestration (STT, LLM, TTS, VAD) out of the box. It cannot cleanly slot in as another telephony provider alongside Twilio/Telnyx/Plivo because its architecture is fundamentally different: room-based WebRTC with persistent connections vs. webhook-driven HTTP telephony. The recommended path is a **separate `extensions/livekit-voice/` plugin** for browser-based voice chat (the highest-value new capability), with LiveKit's built-in SIP bridge as a future option to unify telephony under one media backend. LiveKit Cloud's free tier (1,000 agent minutes, 5,000 WebRTC minutes) is sufficient for development and small deployments; self-hosting is viable but demands significant ops investment.

---

## 2. Key Findings

| # | Finding | Confidence | Researchers Agree? |
|---|---------|------------|-------------------|
| 1 | LiveKit's `VoiceCallProvider` interface mismatch is fundamental, not superficial -- webhooks, phone numbers, and REST-based media control have no LiveKit equivalents | **High** | All 4 agree |
| 2 | A separate plugin (`extensions/livekit-voice/`) is the cleanest integration path; forcing LiveKit into the existing voice-call provider pattern would require extensive no-ops and adapter code | **High** | 3 of 4 agree (one suggests adapter pattern as viable alternative -- see Section 6) |
| 3 | LiveKit's SIP bridge can replace Twilio/Telnyx/Plivo for telephony by bridging PSTN calls into WebRTC rooms, enabling a unified media backend for both browser and phone | **High** | All 4 agree this is architecturally sound; timing/maturity needs validation |
| 4 | Browser-based voice chat via LiveKit is the highest-value integration point because OpenClaw currently lacks this capability entirely | **High** | 2 researchers explicitly state this; others implicitly support |
| 5 | The Node.js Agents SDK (`@livekit/agents` v1.x) has sufficient plugin coverage for core use cases (OpenAI, Deepgram, ElevenLabs, Cartesia, Silero VAD) but fewer STT plugins than Python | **High** | All researchers note this gap |
| 6 | LiveKit Cloud free tier is adequate for prototyping; production telephony adds ~$0.01/min agent sessions plus SIP/DID costs | **High** | Infrastructure researcher confirms |
| 7 | Discord voice integration via LiveKit is technically possible but not a natural fit -- the existing `@discordjs/voice` pipeline is simpler and more reliable | **Medium** | Integration researcher notes this; others did not investigate |

---

## 3. LiveKit Agents SDK Overview

### Architecture: Worker-Job Model

LiveKit Agents uses a **Worker-Job** architecture where agent servers register with a LiveKit server (Cloud or self-hosted), receive dispatch requests, and spawn **isolated job processes** that join WebRTC rooms as full participants.

```
Agent Server (Worker)
  -> Registers with LiveKit Server
  -> Receives dispatch request (room created / SIP call / explicit API)
  -> Spawns isolated Job process
    -> Joins room as participant
    -> AgentSession orchestrates voice pipeline
    -> Job terminates when room empties (10s grace period)
```

### Voice Pipeline

The SDK provides two voice agent patterns:

1. **VoicePipelineAgent** (composable STT -> LLM -> TTS): Pluggable providers for each stage, customizable pipeline nodes (`stt_node`, `llm_node`, `tts_node`), lifecycle hooks (`on_enter`, `on_exit`, `on_user_turn_completed` for RAG injection).

2. **RealtimeModel** (speech-to-speech): Direct integration with OpenAI Realtime API and Google Gemini Live. Routes WebRTC audio through the provider's WebSocket API. Captures vocal nuance lost in STT conversion.

Both patterns are orchestrated through **AgentSession**, the core orchestrator that manages lifecycle phases: Initializing -> Starting -> Running (listening/thinking/speaking cycle) -> Closing.

### Room Model

LiveKit is a WebRTC SFU (Selective Forwarding Unit). Core primitives:
- **Rooms**: virtual spaces with unique names, configurable limits
- **Participants**: users, agents, SIP callers -- all equal peers
- **Tracks**: audio/video/data streams published and subscribed

Agents join rooms as **full participants** with the same publish/subscribe capabilities as human users. Media flows as RTP packets: participant -> LiveKit SFU -> subscribed participants.

### Dispatch: Automatic vs Explicit

- **Automatic** (default): agents join every new room
- **Explicit**: via REST API (`AgentDispatchService`), via access token, or via SIP inbound rules
- Dispatch latency: <150ms, scales to hundreds of thousands of connections per second

### Node.js SDK Plugin Availability

| Plugin | Capabilities |
|--------|-------------|
| `@livekit/agents-plugin-openai` | LLM, TTS, STT, Realtime |
| `@livekit/agents-plugin-google` | LLM, TTS |
| `@livekit/agents-plugin-deepgram` | STT, TTS |
| `@livekit/agents-plugin-elevenlabs` | TTS |
| `@livekit/agents-plugin-cartesia` | TTS |
| `@livekit/agents-plugin-silero` | VAD |
| `@livekit/agents-plugin-livekit` | End-of-utterance detection |

**Gap**: Python SDK has significantly more STT plugins (AssemblyAI, Azure, Google Cloud, Amazon Transcribe, Groq, etc.). Node.js STT is limited to Deepgram, OpenAI, and a few others. This matters if OpenClaw wants non-OpenAI/Deepgram STT providers.

---

## 4. OpenClaw Voice Architecture Analysis

### Provider Pattern

The voice-call extension at `extensions/voice-call/` uses a clean provider pattern. Every provider implements `VoiceCallProvider` (defined in `extensions/voice-call/src/providers/base.ts`) with 8 required methods:

| Method | Purpose | LiveKit Equivalent |
|--------|---------|-------------------|
| `verifyWebhook(ctx)` | Validate webhook signature | N/A (no webhooks for real-time events) |
| `parseWebhookEvent(ctx)` | Parse HTTP POST into normalized events | N/A (events arrive via SDK subscription) |
| `initiateCall(input)` | Outbound call with E.164 phone numbers | `CreateSIPParticipant` (SIP) or create room + dispatch agent (WebRTC) |
| `hangupCall(input)` | End active call | Remove participant / close room |
| `playTts(input)` | Send TTS audio to caller | Publish audio track via Agents TTS pipeline |
| `startListening(input)` | Start STT | Control STT agent in room |
| `stopListening(input)` | Stop STT | Pause STT subscription |
| `getCallStatus(input)` | Query call state (for restore) | Query room/participant state via Server SDK |

### Provider Registration (Hardcoded)

Adding a new provider requires touching three locations:
1. `extensions/voice-call/src/types.ts:8` -- `ProviderNameSchema` Zod enum (currently `["telnyx", "twilio", "plivo", "mock"]`)
2. `extensions/voice-call/src/config.ts:260` -- config schema provider enum
3. `extensions/voice-call/src/runtime.ts` -- `resolveProvider()` switch statement

### Event Model

All providers normalize events into a `NormalizedEvent` discriminated union (`extensions/voice-call/src/types.ts`):
`call.initiated`, `call.ringing`, `call.answered`, `call.active`, `call.speaking`, `call.speech`, `call.silence`, `call.dtmf`, `call.ended`, `call.error`

The `CallManager` (`extensions/voice-call/src/manager.ts`) processes these events and manages the call lifecycle state machine. It is provider-agnostic and would work with any source of `NormalizedEvent` objects.

### Integration Surface Constraints

1. **Webhook-centric event delivery**: `VoiceCallWebhookServer` (`extensions/voice-call/src/webhook.ts`) starts an HTTP server on port 3334. Providers register a public webhook URL; telephony services send HTTP POSTs for state changes. LiveKit does not use this model.

2. **Twilio-specific media handler**: `MediaStreamHandler` (`extensions/voice-call/src/media-stream.ts`) is tightly coupled to Twilio's WebSocket media stream protocol (base64-encoded mu-law payloads, `TwilioMediaMessage` interface). LiveKit uses WebRTC tracks with Opus codec at 48kHz -- completely different transport.

3. **Runtime assumes webhooks**: `VoiceCallRuntime` type (`extensions/voice-call/src/runtime.ts`) includes `webhookServer` and `webhookUrl` as required fields. A LiveKit provider would need neither.

4. **Provider-specific runtime wiring**: The Twilio provider gets special treatment during initialization (`setPublicUrl()`, `setTTSProvider()`, `setMediaStreamHandler()`). The runtime has embedded knowledge of provider-specific setup.

### What Would NOT Need Changes

- **CallManager**: Provider-agnostic, works with any `NormalizedEvent` source
- **Core bridge** (`extensions/voice-call/src/core-bridge.ts`): Higher-level agent integration, provider-independent
- **Response generator** (`extensions/voice-call/src/response-generator.ts`): AI response generation, provider-independent
- **Call persistence**: `~/.openclaw/voice-calls/calls.jsonl` format works for any provider

---

## 5. Architectural Comparison

### WebRTC (LiveKit) vs Telephony Webhook (Twilio/Telnyx/Plivo)

| Dimension | LiveKit (WebRTC) | Current Telephony Providers |
|-----------|-----------------|---------------------------|
| **Transport** | WebRTC (UDP, RTP via SFU) | SIP signaling + RTP media |
| **Event delivery** | Persistent WebSocket/gRPC subscription | HTTP POST webhooks |
| **Media format** | Opus 48kHz via WebRTC tracks | G.711 mu-law 8kHz via WebSocket |
| **Client requirement** | LiveKit client SDK (JS, Swift, Android, etc.) | Phone network (no SDK needed) |
| **Latency (transport)** | Sub-100ms theoretical | ~150-300ms network + LLM inference |
| **Call initiation** | Create room + dispatch agent | REST API to provider + webhook registration |
| **STT/TTS** | Native in Agents SDK pipeline | Custom: OpenAI Realtime STT + TelephonyTtsProvider |
| **Turn detection** | Built-in transformer-based VAD | Server-side VAD via OpenAI Realtime |
| **Interruption handling** | Built-in barge-in support | Manual via media stream events |
| **Scaling** | LiveKit SFU handles media routing | Each provider has own scaling |
| **SIP/PSTN support** | Via LiveKit SIP bridge | Native (this is what they do) |
| **Browser voice** | Native (primary use case) | Not supported |
| **Tunnel requirement** | None (agent connects outbound to LiveKit) | ngrok/Tailscale for webhook URL |

### Key Practitioner Insight

For PSTN-based AI voice calls, the **telephone network limits audio quality** (G.711 8kHz) and the **LLM limits response speed** -- transport layer changes between those bottlenecks have minimal impact. WebRTC becomes meaningfully better when:
- Callers use VoIP/browser/app clients (removing PSTN quality ceiling)
- LLM response times improve enough that transport latency matters
- Wideband codecs work end-to-end

LiveKit's SIP bridge allows serving both paths from one infrastructure, making it a future-proof choice.

---

## 6. Integration Recommendation

### Recommended: Separate Plugin (`extensions/livekit-voice/`)

All four researchers agree that LiveKit cannot cleanly fit into the existing `VoiceCallProvider` interface. The disagreement is on degree:

- **Researchers 1, 3, 4**: Separate plugin is clearly the right approach. The interface mismatch is fundamental (not a matter of adapter code complexity).
- **Researcher 2**: An adapter pattern *could* work (LiveKit worker synthesizes `NormalizedEvent` objects and injects them into `CallManager.processEvent()`), but acknowledges this requires significant adaptation and no-ops for `verifyWebhook`/`parseWebhookEvent`.

**Resolution**: The adapter approach is technically feasible but architecturally wrong. It would:
- Require dummy implementations of `verifyWebhook` and `parseWebhookEvent`
- Force LiveKit's persistent-connection model through a webhook-shaped hole
- Miss LiveKit's native pipeline advantages (built-in VAD, interruption handling, streaming)
- Create confusing no-op code paths

A separate plugin avoids all of these issues and enables the highest-value feature: browser voice chat.

### Phased Approach (Hybrid Option C)

1. **Phase 1**: Separate `extensions/livekit-voice/` plugin for browser voice chat
2. **Phase 2**: Add SIP bridge support to the LiveKit plugin for telephony
3. **Phase 3** (optional): Deprecate direct telephony providers as LiveKit SIP matures

---

## 7. Implementation Roadmap

### Phase 1: Browser Voice Chat (weeks 1-3)

**Goal**: Enable voice conversations through the OpenClaw web UI via LiveKit.

Files to create:
- `extensions/livekit-voice/package.json` -- deps: `@livekit/agents`, `@livekit/agents-plugin-openai`, `@livekit/agents-plugin-silero`, `livekit-server-sdk`
- `extensions/livekit-voice/index.ts` -- plugin entry, registers service/tools/gateway methods
- `extensions/livekit-voice/src/worker.ts` -- LiveKit agent worker using `AgentSession` + `VoicePipelineAgent`
- `extensions/livekit-voice/src/config.ts` -- Zod schema for LiveKit config (apiKey, apiSecret, url, roomPrefix)
- `extensions/livekit-voice/src/token.ts` -- Access token generation for browser clients

Gateway integration:
- New endpoint `livekit.connect` returns `{ token, url }` for the browser client
- Frontend adds a "voice chat" button using `livekit-client` JS SDK

Agent bridge:
- Worker receives user speech via LiveKit's STT pipeline
- Bridges to OpenClaw's agent system (similar to `agentCommandFromIngress` pattern)
- Returns response via LiveKit's TTS pipeline

### Phase 2: SIP Telephony Bridge (weeks 4-6)

**Goal**: Enable PSTN calls through LiveKit's SIP bridge, unifying telephony and WebRTC.

- Configure LiveKit SIP trunks (inbound + outbound) pointed at existing Twilio/Telnyx SIP endpoints
- Add SIP dispatch rules for routing inbound calls to rooms
- Outbound calls via `CreateSIPParticipant` API
- Same agent worker handles both SIP-bridged and WebRTC participants

### Phase 3: Consolidation (future)

- Evaluate deprecating direct Twilio/Telnyx/Plivo providers
- Extract shared interfaces from voice-call and livekit-voice if patterns converge
- Consider merging into a single voice extension with pluggable transport backends

### Priority Matrix

| Feature | Value | Effort | Priority |
|---------|-------|--------|----------|
| Browser voice chat (Phase 1) | **High** (new capability) | Medium | **P0** |
| SIP telephony bridge (Phase 2) | Medium (replaces existing) | Medium | P1 |
| Discord voice via LiveKit | Low (existing works) | High | P3 |
| Direct telephony provider deprecation | Low | Low | P3 |

---

## 8. Secrets and Credentials

### What LiveKit Needs

LiveKit requires exactly three credentials:

| Credential | Format | Purpose |
|------------|--------|---------|
| `LIVEKIT_API_KEY` | String (e.g., `APIxxxxxx`) | Identifies the issuer for JWT signing |
| `LIVEKIT_API_SECRET` | String (base64-encoded) | Signs JWTs to prevent forgery |
| `LIVEKIT_URL` | WSS URL (e.g., `wss://my-project.livekit.cloud`) | LiveKit server WebSocket endpoint |

Access tokens are JWTs generated server-side containing: `exp` (expiration), `iss` (API key), `sub` (participant identity), `video` (room grants/permissions), `sip` (SIP grants). Token expiration only affects initial connection; servers proactively refresh for reconnection.

### Mapping to OpenClaw's SecretRef + 1Password

OpenClaw's `SecretInput` type (`src/config/types.secrets.ts`) supports `string | SecretRef` where `SecretRef` has `source` ("env" | "file" | "exec"), `provider`, and `id`.

**openclaw.json config example** (separate plugin):

```json
{
  "plugins": {
    "entries": {
      "livekit-voice": {
        "config": {
          "url": "wss://my-project.livekit.cloud",
          "apiKey": {
            "source": "env",
            "provider": "default",
            "id": "LIVEKIT_API_KEY"
          },
          "apiSecret": {
            "source": "env",
            "provider": "default",
            "id": "LIVEKIT_API_SECRET"
          },
          "stt": "deepgram/nova-3:en",
          "tts": "cartesia/sonic-3",
          "llm": "openai/gpt-4.1-mini",
          "roomPrefix": "openclaw-",
          "sip": {
            "enabled": false,
            "trunkId": "",
            "outboundNumber": ""
          }
        }
      }
    }
  }
}
```

**With 1Password (exec provider)**:

```json
{
  "plugins": {
    "entries": {
      "livekit-voice": {
        "config": {
          "url": "wss://my-project.livekit.cloud",
          "apiKey": {
            "source": "exec",
            "provider": "op",
            "id": "LIVEKIT_API_KEY"
          },
          "apiSecret": {
            "source": "exec",
            "provider": "op",
            "id": "LIVEKIT_API_SECRET"
          }
        }
      }
    }
  }
}
```

### secrets.env Additions

```bash
# LiveKit credentials
LIVEKIT_API_KEY=APIxxxxxxxxxxxxxxxxx
LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LIVEKIT_URL=wss://my-project.livekit.cloud
```

### 1Password Vault Entries

```
op://shared.dev/LIVEKIT_API_KEY/credential
op://shared.dev/LIVEKIT_API_SECRET/credential
op://shared.dev/LIVEKIT_URL/credential
```

---

## 9. LiveKit Cloud vs Self-Hosted

| Dimension | LiveKit Cloud | Self-Hosted |
|-----------|--------------|-------------|
| **Setup time** | Minutes (dashboard signup) | Hours to days (Redis, TLS, TURN, DNS) |
| **Credentials** | API key + secret from dashboard | Generate own key pairs |
| **Infrastructure** | Fully managed | You manage: compute, Redis, TLS certs, TURN server, UDP port range (50000-60000) |
| **Scaling** | Automatic, global mesh SFU | Manual: load-aware autoscaling via configurable thresholds (CPU default 0.7) |
| **Multi-region** | Built-in, 15+ regions across 6 continents | Manual: geo-aware DNS, Redis mesh, region-aware node selector |
| **Per-room limit** | No documented limit | ~3,000 participants (room must fit on single node) |
| **SIP bridge** | Included, managed | Deploy `livekit/sip` service separately |
| **AI Inference** | Managed (Deepgram, ElevenLabs, OpenAI, etc.) via consolidated billing | Self-managed: bring your own API keys for each provider |
| **Uptime SLA** | 99.99% (claimed) | None (you own it) |
| **Analytics** | Built-in dashboards | Custom / external |
| **TURN/TLS** | Automatic | Separate domain + cert required |
| **Agent hosting** | Cloud-hosted or self-hosted workers connect to Cloud SFU | Co-located with SFU or separate |
| **Data residency** | Region pinning on Scale+ plan | Full control |
| **Cost (low volume)** | Free tier: 1,000 agent min, 5,000 WebRTC min | Compute + bandwidth costs from day 1 |
| **Cost (high volume)** | $0.01/min agent + bandwidth + inference | Fixed infra cost, potentially cheaper at scale |
| **Recommended for** | Development, small-medium deployments, quick start | Compliance requirements, high-volume cost optimization, air-gapped environments |

### Self-Hosted Requirements Summary

- **Ports**: TCP 7880 (signaling), 7881 (RTC TCP), 5349 (TURN/TLS), UDP 50000-60000 (media)
- **Dependencies**: Redis (required for multi-node, egress, ingress), domain with CA-signed TLS
- **Compute**: 4 cores / 8GB RAM per agent node (~30 concurrent agents), 10Gbps ethernet recommended
- **Docker**: Host networking required (not bridge mode)
- **Critical constraint**: A single room must fit on a single node

### Recommendation

Start with **LiveKit Cloud** (free tier) for development and initial deployment. The operational overhead of self-hosting is not justified until either (a) data residency requirements force it, or (b) volume exceeds ~$500/month on Cloud pricing, making self-hosted cost-competitive.

---

## 10. Risks and Open Questions

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Node.js Agents SDK has fewer STT plugins than Python | **Medium** | Core providers (OpenAI, Deepgram) are available; add custom STT node if needed |
| LiveKit SIP bridge maturity for production telephony | **Medium** | Start with browser voice (Phase 1); evaluate SIP in Phase 2 with fallback to existing providers |
| Dependency on LiveKit Cloud availability for browser voice | **Medium** | Self-hosted fallback path exists; design config to support both |
| Agent worker process lifecycle management in OpenClaw's plugin system | **Medium** | Need to verify OpenClaw plugin SDK supports long-running worker processes (not just request handlers) |
| Audio quality regression if SIP bridge replaces direct Twilio integration | **Low** | SIP bridge audio quality is bounded by the same G.711 telephony codec; no degradation expected for PSTN calls |

### Open Questions

1. **Plugin SDK worker support**: Does OpenClaw's plugin SDK (`openclaw/plugin-sdk`) support registering a long-running worker process (LiveKit agent server), or only request-response handlers? This determines whether the LiveKit agent worker runs inside the plugin lifecycle or as a sidecar process.

2. **LiveKit SIP bridge capacity**: What are the concurrent SIP call limits per LiveKit Cloud project? Not documented; needs testing or support inquiry.

3. **Node.js SDK feature parity timeline**: When will Node.js SDK reach full plugin parity with Python? Multi-speaker diarization (`MultiSpeakerAdapter`) is Python-only.

4. **LiveKit Cloud inference region availability**: Are all managed inference models (Deepgram, ElevenLabs, etc.) available in all Cloud regions? Not documented.

5. **Cost at scale**: What does LiveKit Cloud cost at 1,000+ concurrent agent sessions? The free tier covers prototyping, but production telephony cost comparison vs. direct Twilio/Telnyx needs modeling.

6. **Web UI frontend**: Where does the OpenClaw web provider frontend code live? The `livekit-client` JS SDK integration point for the "voice chat" button needs to be identified. (May be in a separate repo or built artifact.)

7. **Latency benchmark**: How does LiveKit SIP bridge latency compare to direct Twilio/Telnyx WebSocket media streams? Practitioners suggest transport layer differences are minimal for PSTN calls (bottleneck is LLM inference), but this should be validated.

8. **LiveKit Cloud rate limits and quotas**: The free/Ship tier quota details (at `https://docs.livekit.io/deploy/admin/quotas-and-limits/`) were not fully investigated and may affect development velocity.

---

## Appendix: Source Summary

### LiveKit Official Documentation
- Agents SDK: https://docs.livekit.io/agents/
- Voice Pipeline: https://docs.livekit.io/agents/voice-agent/voice-pipeline/
- Agent Sessions: https://docs.livekit.io/agents/logic/sessions/
- Agent Dispatch: https://docs.livekit.io/agents/build/dispatch/
- Models/Plugins: https://docs.livekit.io/agents/models/
- Telephony/SIP: https://docs.livekit.io/telephony/
- Self-Hosting: https://docs.livekit.io/transport/self-hosting/
- Tokens: https://docs.livekit.io/frontends/authentication/tokens/
- Pricing: https://livekit.com/pricing

### OpenClaw Codebase (key files)
- `extensions/voice-call/src/providers/base.ts` -- VoiceCallProvider interface
- `extensions/voice-call/src/types.ts` -- ProviderNameSchema, NormalizedEvent union, CallState
- `extensions/voice-call/src/config.ts` -- VoiceCallConfigSchema, provider config validation
- `extensions/voice-call/src/runtime.ts` -- VoiceCallRuntime type, resolveProvider(), createVoiceCallRuntime()
- `extensions/voice-call/src/webhook.ts` -- VoiceCallWebhookServer (HTTP webhook + WS upgrade)
- `extensions/voice-call/src/media-stream.ts` -- MediaStreamHandler (Twilio-specific)
- `extensions/voice-call/src/manager.ts` -- CallManager (provider-agnostic lifecycle)
- `extensions/voice-call/src/providers/stt-openai-realtime.ts` -- OpenAI Realtime STT
- `extensions/voice-call/src/telephony-tts.ts` -- TelephonyTtsProvider (PCM to mu-law bridge)
- `extensions/voice-call/src/core-bridge.ts` -- Core agent integration bridge
- `src/config/types.secrets.ts` -- SecretRef, SecretInput types

### GitHub Repositories
- LiveKit Agents JS: https://github.com/livekit/agents-js
- LiveKit Agents Python: https://github.com/livekit/agents
- LiveKit Server: https://github.com/livekit/livekit
- LiveKit SIP: https://github.com/livekit/sip
- LiveKit Client SDK JS: https://github.com/livekit/client-sdk-js
