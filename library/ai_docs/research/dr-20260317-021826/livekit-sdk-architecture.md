## Research Findings

**Sub-question**: How does the LiveKit Agents SDK architecture work for voice AI applications?

### Key Answer

LiveKit Agents SDK provides a Worker-Job architecture where agent servers register with LiveKit Cloud, receive dispatch requests, and spawn isolated job processes that join WebRTC rooms as full participants. The SDK offers two primary voice agent patterns: a VoicePipelineAgent (STT -> LLM -> TTS pipeline) for composable model selection and a RealtimeModel integration (e.g., OpenAI Realtime API) for direct speech-to-speech, both orchestrated through a unified AgentSession abstraction available in Python and Node.js.

### Evidence

#### Point 1: Worker-Job Architecture and Agent Lifecycle

When agent code starts, it registers with a LiveKit server as an "agent server" process. The server waits for dispatch requests, then boots a "job" subprocess that joins the room. Each job runs in a **separate process** to isolate agents from each other -- if one session crashes, it does not affect other agents on the same server. The job runs until all standard and SIP participants leave the room, or you explicitly shut it down.

The worker lifecycle is:
1. Agent server registers with LiveKit Cloud/self-hosted server
2. Server dispatches a job when a room needs an agent
3. Worker spawns an isolated process for the job
4. Entrypoint function executes (decorated with `@server.rtc_session()` in Python, default export in Node.js)
5. AgentSession starts and connects to the room
6. Job terminates on room empty or explicit shutdown (with 10-second grace period)

- Source: https://docs.livekit.io/agents/server/job/
- Confidence: High

#### Point 2: AgentSession -- The Core Orchestrator

AgentSession is "the main orchestrator for your voice AI app," handling user input collection, voice pipeline management, LLM invocation, and response delivery. It progresses through four lifecycle phases:

1. **Initializing** -- setup, no audio/video processing yet
2. **Starting** -- I/O connections established, agent enters "listening" state
3. **Running** -- active processing; agent cycles between "listening," "thinking," and "speaking"
4. **Closing** -- graceful shutdown including pending speech drainage

AgentSession connects to rooms via **RoomIO**, a utility class that bridges the session and the LiveKit room, managing media tracks. By default, AgentSession auto-creates a RoomIO object enabling all room participants to subscribe to available audio tracks. Configuration example:

```python
session = AgentSession(
    stt="deepgram/nova-3:en",
    llm="openai/gpt-4.1-mini",
    tts="cartesia/sonic-3:<voice-id>",
    vad=silero.VAD.load(),
)
await session.start(room=ctx.room, agent=Agent(instructions="You are a helpful voice AI assistant."))
```

- Source: https://docs.livekit.io/agents/logic/sessions/
- Confidence: High

#### Point 3: VoicePipelineAgent -- STT -> LLM -> TTS Pipeline

VoicePipelineAgent is a high-level abstraction that orchestrates conversation flow using a pipeline of three main models: STT (Speech-to-Text) -> LLM (Large Language Model) -> TTS (Text-to-Speech). Additional models like VAD (Voice Activity Detection) enhance the flow.

The pipeline provides customizable **nodes** that developers can override:

- **`stt_node()`** -- Transcribes input audio frames into speech events (FINAL_TRANSCRIPT, INTERIM_TRANSCRIPT, START_OF_SPEECH, END_OF_SPEECH)
- **`llm_node()`** -- Performs inference on current chat context, yields text or ChatChunk objects with optional tool calls
- **`tts_node()`** -- Synthesizes speech from LLM text output

Lifecycle hooks are also available:
- `on_enter()` -- triggered when agent becomes active
- `on_exit()` -- called before agent handoff
- `on_user_turn_completed()` -- fires when user's turn ends, before agent reply (useful for RAG injection)

Key built-in capabilities: streaming audio pipeline, reliable turn detection via transformer model, interruption handling, and LLM tool-use orchestration.

- Source: https://docs.livekit.io/agents/voice-agent/voice-pipeline/
- Source: https://docs.livekit.io/agents/build/nodes/
- Confidence: High

#### Point 4: Realtime API Integration (Speech-to-Speech)

For direct speech-to-speech without a separate STT/TTS pipeline, LiveKit integrates with OpenAI's Realtime API and Google Gemini Live via the `RealtimeModel` class. The integration routes WebRTC audio streams from clients through OpenAI's WebSocket-based Realtime API.

```typescript
// Node.js example
import * as openai from '@livekit/agents-plugin-openai';
const session = new voice.AgentSession({
   llm: new openai.realtime.RealtimeModel({ voice: "marin" }),
});
```

Key configuration: model selection, voice choice (alloy, marin, etc.), temperature (0.6-1.2), modalities (text, audio, or both), and turn detection (semantic_vad or server_vad). Setting `modalities=["text"]` enables using a separate TTS provider while still getting realtime speech comprehension.

The MultimodalAgent (legacy v0 name, now configured through AgentSession + RealtimeModel in v1) accepts audio directly, enabling it to "hear" voice and capture nuances like emotion that are lost in STT conversion.

- Source: https://docs.livekit.io/agents/integrations/openai/realtime/
- Source: https://docs.livekit.io/agents/models/
- Confidence: High

#### Point 5: Room-Based Model and WebRTC Architecture

LiveKit is a WebRTC-based SFU (Selective Forwarding Unit). Core primitives:

- **Rooms** -- virtual spaces with unique names, configurable max participants and empty timeout
- **Participants** -- users, agents, SIP callers, or services. Each has a unique identity within the room. Agents join as **full participants** with the same publish/subscribe capabilities as humans.
- **Tracks** -- media streams (audio, video, data) that participants publish and subscribe to

The agent connects to the same room as a server-side WebRTC client. It receives audio/video streams in real time, can send its own streams, and has full access to session state. Media flows as RTP packets through the SFU: participant -> LiveKit Server -> subscribed participants.

Data channels (built on WebRTC DataChannel) enable low-latency messaging for chat, events, and metadata between participants.

- Source: https://docs.livekit.io/intro/basics/rooms-participants-tracks/
- Source: https://docs.livekit.io/intro/basics/connect/
- Confidence: High

#### Point 6: Agent Dispatch -- Automatic vs Explicit

LiveKit's dispatch system supports hundreds of thousands of new connections per second with max dispatch time under 150ms.

**Automatic dispatch** (default): Agents automatically join new rooms when created. Best for assigning the same agent to all participants.

**Explicit dispatch**: Activated by setting an `agent_name` property. Three methods:

1. **Via API** (`AgentDispatchService`) -- programmatic dispatch with metadata:
   ```python
   dispatch = await lkapi.agent_dispatch.create_dispatch(
       api.CreateAgentDispatchRequest(agent_name="test-agent", room="my-room", metadata='{"user_id": "12345"}')
   )
   ```
2. **On Token Creation** -- dispatch encoded in access tokens so agents join when participants connect
3. **Via SIP Inbound Rules** -- for telephony use cases

Rooms are auto-created during dispatch if they do not already exist. Multiple agents can be dispatched simultaneously via multiple `RoomAgentDispatch` entries.

- Source: https://docs.livekit.io/agents/build/dispatch/
- Confidence: High

#### Point 7: Python SDK vs Node.js SDK

Both SDKs have reached **1.0 stable releases** (Node.js 1.0 released August 2025). Python was the original implementation; Node.js is a distribution of the same framework.

Key differences:
- **Plugin packaging**: Python uses optional dependencies on the base SDK (`uv add "livekit-agents[openai]~=1.4"`), Node.js uses individual packages (`pnpm add "@livekit/agents-plugin-openai@1.x"`)
- **Plugin availability**: Most STT plugins are Python-only (Amazon Transcribe, Azure AI Speech, Google Cloud, etc.). Node.js has fewer STT plugins (Deepgram, OpenAI, OVHCloud, Sarvam confirmed). Core providers (OpenAI, Deepgram, ElevenLabs, Cartesia, Silero, Google) are available on both.
- **Feature parity**: Both SDKs share the same core architecture (AgentSession, VoicePipelineAgent, RealtimeModel, dispatch). The Python SDK has some advanced features (multi-speaker diarization via `MultiSpeakerAdapter`) that may not be in Node.js yet.
- **Maturity**: Python has a larger plugin ecosystem and more community examples. Node.js is production-ready but has a smaller plugin surface.

Node.js plugin packages confirmed available:
| Plugin | Capabilities |
|--------|-------------|
| @livekit/agents-plugin-openai | LLM, TTS, STT, Realtime |
| @livekit/agents-plugin-google | LLM, TTS |
| @livekit/agents-plugin-deepgram | STT, TTS |
| @livekit/agents-plugin-elevenlabs | TTS |
| @livekit/agents-plugin-cartesia | TTS |
| @livekit/agents-plugin-silero | VAD |
| @livekit/agents-plugin-livekit | End-of-utterance detection |

- Source: https://github.com/livekit/agents-js
- Source: https://docs.livekit.io/agents/models/stt/
- Confidence: High

#### Point 8: Plugin System Architecture

The LiveKit Agents plugin framework is extensible and community-driven. Each plugin supports a single provider but may cover multiple capabilities (e.g., OpenAI plugin covers LLM, STT, TTS, and Realtime API).

**How plugins work**: Plugins implement standard interfaces (`STT`, `LLM`, `TTS`, `RealtimeModel`) that the AgentSession or VoicePipelineAgent consumes. The framework supports:

- **Shorthand model descriptors**: `stt="deepgram/nova-3:en"` or `tts="cartesia/sonic-3:<voice-id>"`
- **Auto-selection**: `stt="auto:es"` picks the best available model for a language
- **Custom providers**: Override API key and base URL for any OpenAI-compatible provider
- **Custom nodes**: Implement custom STT/LLM/TTS without a plugin by overriding pipeline nodes

Full STT provider list (Python): Deepgram, AssemblyAI, Cartesia (Ink Whisper), ElevenLabs (Scribe), OpenAI (Whisper), Google Cloud, Azure AI Speech, Amazon Transcribe, Groq, Clova, Fal, OVHCloud, Sarvam.

Full TTS provider list: Cartesia, ElevenLabs, Deepgram, OpenAI, Azure, Google, Neuphonic, Resemble, Rime, Inworld.

Full LLM provider list: OpenAI, Google, Groq, xAI, Cerebras, Azure, AWS.

Realtime (speech-to-speech): OpenAI Realtime API, Google Gemini Live.

- Source: https://docs.livekit.io/agents/models/
- Source: https://docs.livekit.io/agents/integrations/
- Confidence: High

### Sources Cited

| Source | URL | Type | Reliability |
|--------|-----|------|-------------|
| LiveKit Agents Introduction | https://docs.livekit.io/agents/ | official docs | High |
| LiveKit Voice Pipeline Agent | https://docs.livekit.io/agents/voice-agent/voice-pipeline/ | official docs | High |
| LiveKit Pipeline Nodes | https://docs.livekit.io/agents/build/nodes/ | official docs | High |
| LiveKit Agent Dispatch | https://docs.livekit.io/agents/build/dispatch/ | official docs | High |
| LiveKit Job Lifecycle | https://docs.livekit.io/agents/server/job/ | official docs | High |
| LiveKit Agent Sessions | https://docs.livekit.io/agents/logic/sessions/ | official docs | High |
| LiveKit Models Overview | https://docs.livekit.io/agents/models/ | official docs | High |
| LiveKit STT Models | https://docs.livekit.io/agents/models/stt/ | official docs | High |
| LiveKit OpenAI Realtime Integration | https://docs.livekit.io/agents/integrations/openai/realtime/ | official docs | High |
| LiveKit Integrations | https://docs.livekit.io/agents/integrations/ | official docs | High |
| LiveKit Rooms, Participants, Tracks | https://docs.livekit.io/intro/basics/rooms-participants-tracks/ | official docs | High |
| LiveKit agents-js GitHub | https://github.com/livekit/agents-js | official repo | High |
| LiveKit agents GitHub (Python) | https://github.com/livekit/agents | official repo | High |
| Moravio LiveKit Architecture Blog | https://www.moravio.com/blog/livekit-agents-for-building-real-time-ai-agents | blog | Medium |
| LiveKit + OpenAI Partnership Blog | https://blog.livekit.io/openai-livekit-partnership-advanced-voice-realtime-api/ | official blog | High |

### Overall Confidence: High

**Reasoning**: All findings are sourced from official LiveKit documentation (docs.livekit.io) and official GitHub repositories, with the framework at a stable 1.0 release as of 2025.

### Gaps & Limitations

- **Node.js SDK plugin gap details**: The exact feature parity between Python and Node.js plugins is not fully documented. Some plugins listed as Python-only may have Node.js equivalents that were not surfaced in the documentation.
- **Scaling numbers**: While dispatch latency (<150ms) and throughput (hundreds of thousands per second) are documented, detailed benchmarks for concurrent agent sessions per worker or memory usage per job were not found.
- **Self-hosted vs Cloud differences**: The dispatch and scaling documentation focuses on LiveKit Cloud. Self-hosted deployment architecture details (e.g., how agent workers connect to a self-hosted LiveKit server, load balancing configuration) were not deeply covered.
- **WebRTC codec details**: The specific audio codecs used between agents and the SFU (Opus, etc.) and any codec negotiation details for the agent<->model path were not investigated.
- **Version specifics**: The research reflects the 1.x architecture (AgentSession-based). The v0 architecture used different class names (VoicePipelineAgent was instantiated directly, MultimodalAgent was a separate class). Some search results may mix v0 and v1 terminology.
- **Cost and billing**: LiveKit Cloud pricing for agent compute, media bandwidth, and model inference was not researched.
