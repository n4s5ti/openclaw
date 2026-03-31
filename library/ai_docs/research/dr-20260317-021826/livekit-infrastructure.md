## Research Findings

**Sub-question**: LiveKit Infrastructure, Credentials & Deployment -- LiveKit Cloud vs self-hosted tradeoffs, credentials/secrets required, and how it compares to telephony webhooks.

### Key Answer

LiveKit Cloud is a fully managed WebRTC infrastructure with tiered pricing (free through enterprise), global regions across 6 continents, built-in SIP telephony bridging, and managed AI inference -- requiring only an API key/secret pair for credentials. Self-hosting is viable but demands significant ops investment (Redis, TURN/TLS, port management, scaling), and LiveKit's SIP bridge can unify both WebRTC and PSTN telephony into a single room-based architecture, making it a credible unified backend for voice.

### Evidence

#### Point 1: LiveKit Cloud Pricing Model
LiveKit Cloud offers four tiers: Build (free), Ship ($50/mo), Scale ($500/mo), and Enterprise (custom). The free tier includes 1,000 agent session minutes, 5,000 WebRTC minutes, $2.50 inference credits, 1 free US phone number, and 50 inbound calling minutes. Overage rates: agent sessions at $0.01/min, STT at $0.0092/min, TTS at $0.0300/min, LLM at $0.0015/min, bandwidth at $0.12/GB (Ship) or $0.10/GB (Scale). Upstream bandwidth is free; only downstream is billed. The pricing model shifted in Feb 2025 to a connection fee ($0.0005/min, decreasing with volume) plus bandwidth model.
- Source: https://livekit.com/pricing
- Confidence: High

#### Point 2: LiveKit Cloud Global Regions
LiveKit Cloud operates in regions spanning 6 continents (as of 2025-12-11): US (Central, East B, West B), EU (West B, Germany, Germany 2), UK, Asia (Japan, Singapore SE), Australia, India (South, West), Africa (South Africa), South America (Brazil), Middle East (Saudi Arabia, UAE, Israel). Region pinning (restricting traffic to a specific geography for data residency/compliance) is available on Scale plan or higher. Multiple SFU instances form a distributed mesh for cross-region media relay.
- Source: https://docs.livekit.io/deploy/admin/regions/region-pinning/
- Confidence: High

#### Point 3: Self-Hosted Deployment Requirements
Self-hosting LiveKit requires: (a) TCP ports 7880 (signaling), 7881 (RTC TCP), 5349 (TURN/TLS); (b) UDP port range 50000-60000 (media); (c) WSS on primary domain; (d) Redis as shared data store and message bus for multi-node or egress/ingress services; (e) a domain with CA-signed TLS cert (self-signed does not work); (f) compute-optimized instances with 10Gbps ethernet recommended; (g) host networking for Docker deployments. TURN/TLS requires a separate domain and SSL cert. For agent servers specifically, 4 cores / 8GB RAM is a starting point, handling roughly 30 concurrent agents per node. A single room must fit on a single node, constraining per-room participant capacity.
- Source: https://docs.livekit.io/transport/self-hosting/deployment/
- Confidence: High

#### Point 4: Self-Hosted vs Cloud Tradeoffs
Key differences: (a) Cloud has no per-room participant limit vs self-hosted ~3,000; (b) Cloud uses a global mesh SFU vs self-hosted single-home SFU; (c) Cloud offers 99.99% uptime guarantee vs none for self-hosted; (d) Cloud includes built-in analytics dashboards vs custom/external for self-hosted; (e) Cloud handles TURN, TLS termination, scaling, and Redis automatically; (f) Multi-region self-hosted requires manual Redis setup, geo-aware DNS (Route53/Cloudflare), and region-aware node selector configuration. Self-hosted has graceful connection draining and load-aware autoscaling via configurable load thresholds (default: CPU at 0.7).
- Source: https://docs.livekit.io/transport/self-hosting/
- Confidence: High

#### Point 5: Credentials and Token Generation
LiveKit requires two credentials: an **API Key** (identifies the issuer) and an **API Secret** (signs JWTs to prevent forgery). These are stored as `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` environment variables. The WebSocket URL format is `wss://<your-project>.livekit.cloud` (Cloud) or `wss://<your-domain>` (self-hosted), with `ws://localhost:7880` for local dev. Access tokens are JWTs containing: `exp` (expiration), `iss` (API key), `sub` (participant identity), `video` (room grants/permissions like `roomJoin`, `canPublish`, `canSubscribe`), `sip` (SIP grants), and optional `metadata`/`attributes`. Tokens are generated server-side using SDKs (Node.js, Go, Python, Ruby, Rust). Token expiration only affects initial connection; servers proactively refresh tokens for reconnection. Short TTLs recommended for self-hosted since token revocation is not automatic.
- Source: https://docs.livekit.io/frontends/authentication/tokens/
- Confidence: High

#### Point 6: LiveKit Inference (Managed AI Models)
LiveKit Inference provides managed access to STT, TTS, and LLM models through LiveKit Cloud with no additional plugin setup or provider accounts needed. **STT providers**: AssemblyAI (Universal-3 Pro, Universal Streaming), Cartesia (Ink Whisper, 100 languages), Deepgram (Flux, Nova-3, Nova-2 variants), ElevenLabs (Scribe V2 Realtime, 41 languages). **TTS providers**: Cartesia (sonic-3/2/turbo), Deepgram (aura-2), ElevenLabs (flash/turbo/multilingual variants), Inworld, Rime, xAI. **LLM providers**: OpenAI (GPT-4o, GPT-5, GPT-5.2), Google (Gemini 3 Pro, 2.5 Flash), DeepSeek, Kimi. Billing is consolidated: LLM by tokens, STT by duration ($0.0025-$0.0105/min), TTS by characters ($4.20-$300/M chars). Beyond Inference, 24+ STT and 30+ TTS providers available via self-managed plugins.
- Source: https://docs.livekit.io/agents/models/stt/ and https://livekit.com/pricing/inference
- Confidence: High

#### Point 7: SIP Bridge -- Unified WebRTC + Telephony Backend
LiveKit's SIP service bridges PSTN calls into WebRTC rooms. Architecture: DID provider -> LiveKit SIP service -> LiveKit Room. Configuration uses **inbound trunks** (handle incoming calls, IP/number restrictions) and **outbound trunks** (programmatic outbound calls). **Dispatch rules** route inbound calls to rooms (same room for all callers, unique rooms per caller, PIN-based routing). SIP URI format: `sip:<project-id>.sip.livekit.cloud`. Supports SIP over UDP/TCP/TLS, RTP/SRTP, DTMF (RFC 2833/4733), cold/warm transfers, caller ID. Tested with Twilio, Telnyx, Exotel, Plivo, Wavix. Krisp AI noise cancellation available. **This means OpenClaw could use LiveKit as a single backend**: browser/app users connect via WebRTC client SDKs, phone users connect via SIP trunks -- both end up as participants in the same LiveKit room.
- Source: https://docs.livekit.io/telephony/
- Confidence: High

#### Point 8: WebRTC vs Telephony Architecture -- Fundamental Differences
**WebRTC path**: Peer-to-peer media (via SFU), ICE/STUN/TURN negotiation, client SDKs required on each platform, UDP-based transport, Opus codec at 48kHz, sub-100ms theoretical latency, requires port management. **Telephony/webhook path**: SIP signaling + RTP media, webhook-driven call control, media streams over WebSocket to application server, no client SDK needed (phone network is the client), G.711 codec at 8kHz, ~150-300ms network latency plus LLM inference time. **Key insight from practitioners**: for PSTN-based AI voice calls, the telephone network limits quality and the LLM limits speed -- transport layer changes between those bottlenecks have minimal impact. WebRTC becomes meaningfully better when: (a) callers use VoIP/browser/app clients (removing PSTN quality ceiling), (b) LLM response times improve enough that transport latency matters, (c) wideband codecs work end-to-end. LiveKit's SIP bridge lets you serve both paths from one infrastructure.
- Source: https://dev.to/nick_lackman/i-tested-our-websocket-audio-pipeline-with-webrtc-heres-why-i-switched-it-back-3g1j and https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents
- Confidence: Medium

#### Point 9: Client SDKs Available
LiveKit provides official client SDKs for: **Web** (JavaScript/TypeScript browser SDK), **React** (component library), **Swift** (iOS/macOS), **Android** (Kotlin/Java), **Flutter** (iOS, Android, Web), **React Native**, **Unity**, **Rust**, **Node.js**, **Python**, **C++**. Each SDK handles WebRTC connection management, media capture, room state, and track subscription. Component libraries with pre-built UI elements exist for React, Swift (SwiftUI), Android (Compose), and Flutter. All SDKs are open source. Any SDK can join the same room, enabling cross-platform interop.
- Source: https://docs.livekit.io/intro/overview/
- Confidence: High

#### Point 10: Multi-Region Self-Hosted Architecture
Distributed self-hosted deployments require Redis as the shared data store and message bus. Nodes discover each other through Redis, periodically reporting statistics for load-aware routing decisions. When a client connects to one node but the room is on another, the first node acts as a signaling bridge, proxying WebSocket messages. Region-aware configuration uses `node_selector` with `kind: regionaware`, specifying region name, latitude, and longitude. Selection prioritizes nodes below a `sysload_limit` threshold, choosing from the geographically closest region. Designed to work with geo-aware DNS services (Route53, Cloudflare). Critical constraint: a room must fit on a single node, limiting per-room capacity even in distributed setups. Graceful shutdown via connection draining is supported.
- Source: https://docs.livekit.io/transport/self-hosting/distributed/
- Confidence: High

### Sources Cited

| Source | URL | Type | Reliability |
|--------|-----|------|-------------|
| LiveKit Pricing | https://livekit.com/pricing | official | High |
| LiveKit Inference Pricing | https://livekit.com/pricing/inference | official | High |
| LiveKit Cloud Regions | https://docs.livekit.io/deploy/admin/regions/region-pinning/ | official | High |
| LiveKit Self-Hosting Overview | https://docs.livekit.io/transport/self-hosting/ | official | High |
| LiveKit Deployment Guide | https://docs.livekit.io/transport/self-hosting/deployment/ | official | High |
| LiveKit Distributed Multi-Region | https://docs.livekit.io/transport/self-hosting/distributed/ | official | High |
| LiveKit Self-Hosted Deployments (Agents) | https://docs.livekit.io/deploy/custom/deployments/ | official | High |
| LiveKit Tokens & Grants | https://docs.livekit.io/frontends/authentication/tokens/ | official | High |
| LiveKit Authentication Overview | https://docs.livekit.io/home/get-started/authentication/ | official | High |
| LiveKit Telephony Introduction | https://docs.livekit.io/telephony/ | official | High |
| LiveKit SIP Trunk Setup | https://docs.livekit.io/telephony/start/sip-trunk-setup/ | official | High |
| LiveKit STT Models | https://docs.livekit.io/agents/models/stt/ | official | High |
| LiveKit TTS Models | https://docs.livekit.io/agents/models/tts/ | official | High |
| LiveKit Agents Framework | https://docs.livekit.io/agents/ | official | High |
| LiveKit SDK Quickstarts | https://docs.livekit.io/home/quickstarts/ | official | High |
| LiveKit GitHub | https://github.com/livekit/livekit | official | High |
| LiveKit SIP GitHub | https://github.com/livekit/sip | official | High |
| Twilio Core Latency Guide | https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents | community/blog | Medium |
| WebRTC vs WebSocket Comparison | https://dev.to/nick_lackman/i-tested-our-websocket-audio-pipeline-with-webrtc-heres-why-i-switched-it-back-3g1j | community/blog | Medium |
| LiveKit Pricing Blog Post | https://blog.livekit.io/towards-a-future-aligned-pricing-model/ | official/blog | High |

### Overall Confidence: High

**Reasoning**: All core infrastructure, pricing, credential, and SIP bridge findings come directly from official LiveKit documentation (fetched and verified), with practitioner sources corroborating the WebRTC vs telephony latency analysis.

### Gaps & Limitations
- **Exact Cloud SFU mesh architecture details** are not publicly documented in depth; the claim of "global mesh SFU" comes from marketing materials rather than technical architecture docs.
- **Actual real-world latency benchmarks** for LiveKit Cloud specifically (vs generic WebRTC) were not found in official sources; the latency comparison relies on community practitioner reports.
- **LiveKit Cloud uptime SLA terms** (the 99.99% figure) were referenced in self-hosting comparison docs but the actual SLA document was not located or verified.
- **Cost comparison at scale** between Cloud and self-hosted was not found; Cloud pricing is transparent but self-hosted infrastructure costs depend heavily on provider and traffic patterns.
- **LiveKit Inference availability by region** is not documented; it is unclear whether all inference models are available in all Cloud regions or only in specific ones.
- **SIP bridge capacity limits** (concurrent SIP calls per project, calls per trunk) were not found in the documentation reviewed.
- **Rate limits and quotas** for the free/Ship tiers exist (referenced at https://docs.livekit.io/deploy/admin/quotas-and-limits/) but were not fetched in detail.
