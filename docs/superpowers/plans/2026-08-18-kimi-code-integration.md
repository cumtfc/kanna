# Kimi Code Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Kimi Code as a first-class Kanna agent provider with the same long-lived, interactive web-chat experience as the existing Claude Code and Codex integrations: persistent sessions, live tool activity, questions/approvals, Plan mode, cancellation, steering, session fork/resume, model/effort selection, and reconnect recovery.

**Architecture:** Kanna talks to the current Kimi Code local server started by `kimi web --no-open`. The Kanna backend owns or connects to that loopback-only process, calls its REST API for commands/state, subscribes to its WebSocket event stream for realtime activity, and normalizes Kimi events into Kanna's existing `HarnessEvent` / `TranscriptEntry` model. The browser never talks to Kimi Code directly and never receives the Kimi server bearer token. A single `KimiCodeManager` multiplexes multiple Kanna chats onto Kimi sessions and owns reconnect/replay logic.

**Tech Stack:** Bun 1.3.5+, TypeScript 5.8, React 19, Kanna `HarnessTurn`, Bun/WHATWG `fetch` + `WebSocket`, Kimi Code `kimi web` REST/WebSocket API. No ACP and no `kimi -p --output-format stream-json` path.

**Spec:** `docs/superpowers/plans/2026-08-18-kimi-code-integration.md` (this document is both the implementation plan and source-of-truth integration spec).

**Validated baselines:**

- Kanna upstream: `jakemor/kanna@7b2c3789cb32adf5b9a42d2732dc18e68308b56d` (`0.64.0`).
- Kimi Code upstream: `MoonshotAI/kimi-code@589ed5467c2fdb97d07f3d8e12619a6d8fb66b32`.
- Re-check Kimi Code's live `/openapi.json` and `/asyncapi.json` during implementation because its local Server API is explicitly experimental.

---

## 1. Scope and behavioral contract

This integration is complete only when Kimi behaves as a native Kanna provider rather than as a terminal embedded in a page.

### Required user-visible behavior

- Kimi appears beside Claude Code, Codex, Cursor and Pi in Kanna's provider selector.
- A chat keeps the same Kimi session across turns and Kanna server/browser reconnects.
- The transcript shows assistant output, thinking/reasoning, tool calls/results, status/context updates and errors in real time.
- The UI can answer Kimi `QuestionRequest` interactions.
- The UI can resolve Kimi approvals, including Plan-mode exit approval.
- Full Access maps to Kimi `permission_mode: "yolo"`, not `auto`: ordinary tools run without prompts, but Kimi can still ask questions and sensitive/Plan approvals remain interactive.
- Plan mode maps to `plan_mode: true`; Kanna's existing Plan UI remains the user-facing mode control.
- Stop aborts the active Kimi prompt/session immediately from Kanna's point of view and best-effort interrupts the runtime.
- A queued Kanna message can be promoted into the active Kimi turn using Kimi's native prompt steering API without cancelling the turn.
- Forking a Kanna chat forks the Kimi session through `/sessions/{id}:fork`.
- If Kanna has a stored Kimi session id that no longer exists, Kanna emits its existing `session_restored` boundary and rebuilds context through the existing handoff/restore mechanism.
- Kimi models and reasoning efforts come from `GET /api/v1/models`; no K3 model list is hard-coded as the authoritative catalog.
- Browser refresh/network loss does not kill the Kimi runtime. Kanna reconnects to Kimi's event stream and repairs missed events using the Kimi cursor/snapshot protocol.

### Explicit non-goals for the first integration

- Do not embed Kimi Code's own web UI in an iframe.
- Do not expose Kimi's bearer token or server port to the browser.
- Do not bind `kimi web` to a non-loopback host.
- Do not use `--dangerous-bypass-auth`.
- Do not depend on `@moonshot-ai/kimi-code-sdk`; current Kimi Code treats it as an internal release package even though its source is SDK-shaped.
- Do not use the deprecated Python `kimi-cli` integration model.
- Do not parse ANSI TUI output.
- Do not treat ACP as the realtime chat transport.
- Do not build Kimi-specific transcript components unless the normalized Kanna message model cannot represent a concrete Kimi feature.

---

## 2. Protocol choices

### 2.1 Kimi transport boundary

Use:

```text
Kanna backend
    |
    | REST: commands / snapshots / model catalog / interactions
    | WS: realtime events + replay cursors
    v
kimi web --no-open
    |
    v
Kimi Code agent runtime + session store
```

Do not use:

```text
Kanna -> kimi -p -> stdout parser
Kanna -> ACP -> one-shot task result
Kanna -> browser iframe -> Kimi Web UI
```

### 2.2 Kanna/Kimi identity mapping

```text
Kanna chat id      -> KimiCodeManager local routing key
Kanna sessionToken -> Kimi session id (`session_...`)
Kanna turn         -> one active Kimi prompt / turn
Kanna queued msg   -> local queue until normal send or native Kimi steer
```

The Kimi server is allowed to have sessions not created by Kanna. Kanna owns only the session ids stored in its chats; never archive/delete unrelated Kimi sessions.

### 2.3 Permission mapping

Kanna's current provider UI exposes `full-access`, `plan`, and Claude-only `auto-plan`. For Kimi:

```ts
function kimiPermissionForKannaMode(planMode: boolean) {
  return {
    permission_mode: "yolo" as const,
    plan_mode: planMode,
  }
}
```

Rationale: Kanna already runs Codex with `approvalPolicy: "never"` + `danger-full-access`. Kimi `yolo` is the closest interactive equivalent while retaining question prompts and the special/sensitive approval channels. Kimi `auto` is deliberately not used because it suppresses human questions and auto-resolves Plan exits.

### 2.4 Experimental API compatibility policy

At server startup, fetch:

```text
GET /api/v1/meta
GET /openapi.json
GET /asyncapi.json
```

Fail Kimi readiness with an actionable message if the live server lacks any required surface:

```text
POST /api/v1/sessions
GET  /api/v1/sessions/{session_id}
POST /api/v1/sessions/{session_id}:fork
POST /api/v1/sessions/{session_id}:abort
POST /api/v1/sessions/{session_id}/prompts
POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer
POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort
GET  /api/v1/sessions/{session_id}/snapshot
GET  /api/v1/sessions/{session_id}/approvals
POST /api/v1/sessions/{session_id}/approvals/{approval_id}
GET  /api/v1/sessions/{session_id}/questions
POST /api/v1/sessions/{session_id}/questions/{question_id}
GET  /api/v1/models
WS   /api/v1/ws
```

Do not compare only a Kimi version string. Feature-detect the protocol surface Kanna actually needs.

---

## 3. Kimi event normalization contract

Create a single normalization layer. Kanna UI code must never switch on raw Kimi event names.

### 3.1 Event mapping

| Kimi event | Kanna behavior |
|---|---|
| `turn.started` | Emit one `system_init` for a new Kanna turn if not already emitted; bind prompt/turn ids. |
| `assistant.delta` | Feed the live assistant-text accumulator. |
| `thinking.delta` | Feed a reasoning/thinking accumulator; emit as Kanna status/reasoning representation supported by the current transcript model. |
| `tool.call.started` | Emit normalized `tool_call`. |
| `tool.call.delta` | Update turn-local tool input accumulator; do not append a second tool card. |
| `tool.progress` | Emit/update a normalized status/tool-progress entry without duplicating the tool call. |
| `tool.result` | Emit normalized `tool_result`. |
| `event.approval.requested` | Register a pending Kanna human interaction and set status `waiting_for_user`. |
| `event.approval.resolved` | Clear matching pending interaction. |
| `event.question.requested` | Emit/register Kanna `ask_user_question`. |
| `event.question.answered` / `dismissed` | Resolve pending question. |
| `compaction.*` | Emit Kanna compact boundary/summary when payload contains the required data; otherwise status only. |
| `turn.ended` | Emit a Kanna `result`; mark finished/failed/cancelled from reason. |
| `prompt.aborted` | Resolve the active prompt as interrupted if `turn.ended` has not already done so. |
| `error` | Emit error result only when it belongs to the active main turn; otherwise surface as provider status/diagnostic. |
| `warning` | Non-fatal status/diagnostic. |
| `subagent.*`, `task.*`, `shell.*` | Preserve as normalized tool/status events where useful; never let a background/subagent event terminate the main Kanna turn. |

### 3.2 Delta policy

Kimi marks text deltas as volatile and supplies cumulative offsets. Do not persist one transcript row per token/chunk.

Add a turn-local accumulator:

```ts
interface KimiTextAccumulator {
  assistant: string
  thinking: string
  assistantOffset: number
  thinkingOffset: number
}
```

For each delta:

1. Verify `offset === localText.length`.
2. If `offset < localText.length`, treat it as a duplicate and ignore it.
3. If `offset > localText.length`, mark the stream as gapped and trigger snapshot/transcript recovery before accepting more text.
4. Update an ephemeral live-turn preview for the browser.
5. Persist a final `assistant_text` entry when the text block/turn is durably closed.

This avoids thousands of append-only `message_appended` records while retaining token-level UI streaming.

### 3.3 Kanna protocol extension for live deltas

Kanna's current `HarnessEvent` only carries append-only transcript entries. Add a provider-neutral ephemeral delta event rather than encoding Kimi semantics in the UI:

```ts
export interface HarnessLiveTextDelta {
  channel: "assistant" | "reasoning"
  text: string
  offset: number
}

export type HarnessEvent =
  | { type: "transcript"; entry: TranscriptEntry }
  | { type: "session_token"; sessionToken: string }
  | { type: "live_text_delta"; delta: HarnessLiveTextDelta }
```

Add a `LiveTurnDraft` to the server read model / chat snapshot:

```ts
export interface LiveTurnDraft {
  assistantText: string
  reasoningText: string
}
```

This state is in-memory only. It is broadcast to clients, is not written to the EventStore, and is cleared when the final transcript entry is appended. Existing providers may adopt this event later; Kimi is the first caller.

---

# Task 1: Add Kimi to the shared provider type system

**Files:**

- Modify: `src/shared/types.ts`
- Modify: `src/shared/provider-preferences.ts`
- Modify: `src/server/provider-catalog.ts`
- Test: `src/shared/provider-preferences.test.ts`
- Test: `src/server/provider-catalog.test.ts`

- [ ] **Step 1: Write failing provider-preference tests**

Add cases proving:

```ts
expect(normalizeProviderPreferences({ kimi: undefined }).kimi).toEqual({
  model: "kimi-code/k3",
  modelOptions: { reasoningEffort: "max" },
  planMode: false,
  autoPlan: false,
})
```

The exact fallback id is only a cold-start default. Runtime model discovery must replace it when Kimi is available.

Also prove arbitrary Kimi effort strings survive normalization when advertised by the model catalog; do not force Kimi through `CodexReasoningEffort`.

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
bun test src/shared/provider-preferences.test.ts src/server/provider-catalog.test.ts
```

Expected: TypeScript/test failures because `kimi` is not an `AgentProvider` and has no preferences/catalog entry.

- [ ] **Step 3: Extend provider types**

In `src/shared/types.ts`:

```ts
export type AgentProvider = "claude" | "codex" | "cursor" | "pi" | "kimi"

export interface KimiModelOptions {
  reasoningEffort: string
}

export interface ProviderModelOptionsByProvider {
  claude: ClaudeModelOptions
  codex: CodexModelOptions
  cursor: CursorModelOptions
  pi: PiModelOptions
  kimi: KimiModelOptions
}
```

Add:

```ts
export const DEFAULT_KIMI_MODEL = "kimi-code/k3"
export const DEFAULT_KIMI_MODEL_OPTIONS = {
  reasoningEffort: "max",
} as const satisfies KimiModelOptions
```

Change `ProviderModelOption.supportedReasoningEfforts` from the Codex-only option type to the generic `ProviderEffortOption[]`; keep the Codex-specific helper return types where needed.

Extend `ChatProviderPreferences` with `kimi`.

- [ ] **Step 4: Add Kimi normalization**

In `src/shared/provider-preferences.ts`, add a `kimi` entry to the exhaustive provider normalizer map. Rules:

- model: trim a non-empty id, else runtime/catalog default, else `DEFAULT_KIMI_MODEL`;
- `reasoningEffort`: any non-empty string, because Kimi's `support_efforts` is provider/model data;
- `planMode`: boolean;
- `autoPlan`: always false.

Do not reuse `normalizeCodexModelOptions`.

- [ ] **Step 5: Add a static cold-start catalog row**

In `src/shared/types.ts`'s `PROVIDERS`:

```ts
{
  id: "kimi",
  label: "Kimi Code",
  defaultModel: DEFAULT_KIMI_MODEL,
  defaultEffort: "max",
  supportsPlanMode: true,
  supportsAutoPlanMode: false,
  models: [{
    id: DEFAULT_KIMI_MODEL,
    label: "K3",
    supportsEffort: true,
    supportedReasoningEfforts: [{ id: "max", label: "Max" }],
    defaultReasoningEffort: "max",
    contextWindowTokens: 1_048_576,
  }],
  efforts: [{ id: "max", label: "Max" }],
}
```

This is only a degraded fallback. Do not add other Kimi model aliases here.

- [ ] **Step 6: Add dynamic catalog application**

In `src/server/provider-catalog.ts` add:

```ts
export interface KimiModelInfo {
  provider: string
  model: string
  displayName?: string
  maxContextSize: number
  capabilities?: string[]
  supportEfforts?: string[]
  defaultEffort?: string
}

export function applyKimiModels(models: KimiModelInfo[]): boolean
export function normalizeKimiModelOptions(...): KimiModelOptions
```

Mapping rules:

- `id = model` exactly as returned by Kimi;
- `label = display_name ?? deriveModelLabel(model)`;
- `contextWindowTokens = max_context_size`;
- `supportsEffort = Boolean(support_efforts?.length)`;
- map every effort string to `{ id, label: deriveEffortLabel(id) }`;
- `defaultReasoningEffort = default_effort` when present;
- the first valid returned model is the fallback default only if the Kimi API does not identify a configured default elsewhere.

- [ ] **Step 7: Run focused tests**

```bash
bun test src/shared/provider-preferences.test.ts src/server/provider-catalog.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/shared/provider-preferences.ts src/shared/provider-preferences.test.ts src/server/provider-catalog.ts src/server/provider-catalog.test.ts
git commit -m "feat: add Kimi provider types and catalog"
```

---

# Task 2: Implement Kimi local-server lifecycle and security boundary

**Files:**

- Create: `src/server/kimi-code-server.ts`
- Create: `src/server/kimi-code-server.test.ts`
- Modify: `src/server/cli.ts` or the server bootstrap module that owns provider manager lifetime

- [ ] **Step 1: Write lifecycle tests with an injected spawn function**

Cover:

1. Parses `Local: http://127.0.0.1:<port>/...` without logging the token fragment.
2. Parses the `Token:` line into memory.
3. Rejects a startup URL whose hostname is not loopback in managed mode.
4. Kills the child when Kanna shuts down.
5. A child exit rejects pending readiness and marks Kimi unavailable.
6. External-server mode requires both URL and token and never spawns a process.
7. No token is included in thrown error messages or diagnostics.

- [ ] **Step 2: Confirm test failure**

```bash
bun test src/server/kimi-code-server.test.ts
```

- [ ] **Step 3: Implement `KimiCodeServerProcess`**

Use an injectable process interface similar to `CodexAppServerProcess`.

Default managed launch:

```ts
spawn("kimi", ["web", "--no-open"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
})
```

Do not pass `--host 0.0.0.0`. Do not pass `--dangerous-bypass-auth`.

The manager exposes:

```ts
export interface KimiServerConnection {
  baseUrl: string
  token: string
  owned: boolean
}

export class KimiCodeServerProcess {
  ensureReady(): Promise<KimiServerConnection>
  stop(): void
}
```

- [ ] **Step 4: Support company/sandbox injection**

Recognize:

```text
KANNA_KIMI_SERVER_URL
KANNA_KIMI_SERVER_TOKEN
```

When both are set, Kanna connects to that server instead of spawning `kimi web`. This is the preferred deployment hook when the company sandbox orchestrator owns the Kimi runtime.

Reject half-configured external mode.

- [ ] **Step 5: Redact credentials**

Create a helper used by every Kimi error/log path:

```ts
function redactKimiServerSecret(message: string, token: string) {
  return token ? message.replaceAll(token, "[REDACTED]") : message
}
```

Never put the Kimi token in Kanna snapshots, EventStore entries, browser messages, analytics or console output.

- [ ] **Step 6: Run tests**

```bash
bun test src/server/kimi-code-server.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/server/kimi-code-server.ts src/server/kimi-code-server.test.ts src/server/cli.ts
git commit -m "feat: manage the local Kimi Code server"
```

---

# Task 3: Implement the Kimi REST client and live capability probe

**Files:**

- Create: `src/server/kimi-code-api.ts`
- Create: `src/server/kimi-code-api.test.ts`

- [ ] **Step 1: Write a local mock HTTP server in tests**

Test the Kimi envelope independently of HTTP status:

```json
{
  "code": 0,
  "msg": "success",
  "data": {},
  "request_id": "req_..."
}
```

Also prove a HTTP 200 body with `code != 0` throws `KimiApiError`.

- [ ] **Step 2: Define only the protocol subset Kanna consumes**

Do not copy the entire Kimi protocol package. Define local interfaces for:

```ts
KimiEnvelope<T>
KimiMeta
KimiSession
KimiSessionStatus
KimiModelItem
KimiPromptItem
KimiApprovalRequest
KimiApprovalResponse
KimiQuestionRequest
KimiQuestionResponse
KimiSnapshot
```

Required prompt body fields:

```ts
interface KimiPromptSubmission {
  content: Array<{ type: "text"; text: string } | /* attachment parts */>
  model?: string
  thinking?: string
  permission_mode?: "manual" | "yolo" | "auto"
  plan_mode?: boolean
  prompt_id?: string
}
```

- [ ] **Step 3: Implement typed request helpers**

```ts
class KimiCodeApi {
  getMeta(): Promise<KimiMeta>
  getOpenApi(): Promise<unknown>
  getAsyncApi(): Promise<unknown>
  getAuth(): Promise<KimiAuthSnapshot>
  listModels(): Promise<KimiModelItem[]>
  createSession(args: ...): Promise<KimiSession>
  getSession(sessionId: string): Promise<KimiSession>
  getSessionStatus(sessionId: string): Promise<KimiSessionStatus>
  forkSession(sessionId: string): Promise<KimiSession>
  abortSession(sessionId: string): Promise<{ aborted: boolean }>
  submitPrompt(sessionId: string, prompt: KimiPromptSubmission): Promise<KimiPromptItem>
  steerPrompt(sessionId: string, promptId: string): Promise<void>
  abortPrompt(sessionId: string, promptId: string): Promise<void>
  listPendingApprovals(sessionId: string): Promise<KimiApprovalRequest[]>
  resolveApproval(sessionId: string, approvalId: string, response: KimiApprovalResponse): Promise<void>
  listPendingQuestions(sessionId: string): Promise<KimiQuestionRequest[]>
  answerQuestion(sessionId: string, questionId: string, response: KimiQuestionResponse): Promise<void>
  dismissQuestion(sessionId: string, questionId: string): Promise<void>
  getSnapshot(sessionId: string): Promise<KimiSnapshot>
}
```

Every request sends:

```text
Authorization: Bearer <token>
```

- [ ] **Step 4: Implement protocol capability validation**

Parse the OpenAPI document only enough to check required paths/methods. Parse AsyncAPI enough to verify `/api/v1/ws` exists.

Return a structured readiness result:

```ts
interface KimiProtocolCompatibility {
  ok: boolean
  missing: string[]
  protocolVersion?: number
}
```

Error text must name the missing surface and advise upgrading/downgrading Kimi Code; do not silently fall back to stdout parsing.

- [ ] **Step 5: Test 404 session semantics**

Expose a predicate:

```ts
isKimiSessionNotFound(error): boolean
```

It must recognize Kimi's session-not-found business code, not only HTTP 404.

- [ ] **Step 6: Run tests**

```bash
bun test src/server/kimi-code-api.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/server/kimi-code-api.ts src/server/kimi-code-api.test.ts
git commit -m "feat: add Kimi Code server API client"
```

---

# Task 4: Implement the shared Kimi WebSocket event connection

**Files:**

- Create: `src/server/kimi-code-events.ts`
- Create: `src/server/kimi-code-events.test.ts`

- [ ] **Step 1: Write tests for handshake and subscription**

Cover:

- wait for `server_hello` before marking ready;
- send `subscribe` with `session_ids`;
- pass the last `{ seq, epoch }` cursor when reconnecting;
- route events only to handlers for their `session_id`;
- ignore/record global events without attributing them to a turn;
- reconnect after unexpected close with bounded exponential backoff;
- stop reconnecting when the manager is closed.

- [ ] **Step 2: Test durable replay and resync**

Simulate:

```text
seq 10 received
socket closes
reconnect with cursor 10
server replays 11..15
```

Then simulate `resync_required` and assert the caller is asked to perform snapshot recovery.

- [ ] **Step 3: Test volatile offset gaps**

For `assistant.delta`:

```text
local length = 12, event.offset = 12 -> append
local length = 20, event.offset = 12 -> duplicate, ignore
local length = 12, event.offset = 20 -> gap, request recovery
```

Do the same for `thinking.delta`.

- [ ] **Step 4: Implement `KimiEventConnection`**

Public surface:

```ts
interface KimiEventCursor {
  seq: number
  epoch?: string | number
}

interface KimiSessionSubscription {
  close(): void
}

class KimiEventConnection {
  start(): Promise<void>
  subscribe(sessionId: string, handlers: {
    onEvent(event: KimiWsEvent): void
    onResyncRequired(): void
  }): Promise<KimiSessionSubscription>
  close(): void
}
```

Use one physical WebSocket per Kimi server, not one socket per chat.

- [ ] **Step 5: Authentication**

On the server side, construct the socket with an Authorization header if the Bun WebSocket client supports it. If the selected client implementation cannot set upgrade headers, use the documented subprotocol form:

```text
kimi-code.bearer.<token>
```

The token remains server-side either way.

- [ ] **Step 6: Run tests**

```bash
bun test src/server/kimi-code-events.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/server/kimi-code-events.ts src/server/kimi-code-events.test.ts
git commit -m "feat: stream Kimi Code server events"
```

---

# Task 5: Add provider-neutral live text drafts to Kanna

**Files:**

- Modify: `src/server/harness-types.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/server/agent.ts`
- Modify: `src/server/read-models.ts`
- Modify: `src/server/ws-router.ts`
- Modify: `src/client/app/useKannaState.ts`
- Modify: `src/client/app/KannaTranscript.tsx` or the lowest existing transcript layer that renders active text
- Test: `src/server/agent.test.ts`
- Test: `src/server/read-models.test.ts`
- Test: `src/client/app/KannaTranscript.test.tsx`

- [ ] **Step 1: Add failing tests for ephemeral deltas**

Prove that:

- live assistant text appears in a chat snapshot before a final transcript entry exists;
- appending the final assistant transcript entry clears the live assistant draft;
- reasoning draft behaves independently;
- EventStore replay does not persist live drafts;
- a browser reconnect sees the current in-memory draft while the Kanna backend remains alive.

- [ ] **Step 2: Extend `HarnessEvent`**

Use the provider-neutral `live_text_delta` shape from section 3.3.

- [ ] **Step 3: Store active drafts in `AgentCoordinator`**

Add:

```ts
private readonly liveTurnDrafts = new Map<string, LiveTurnDraft>()

getLiveTurnDraft(chatId: string): LiveTurnDraft | null
```

On a delta, append to the correct channel and call `emitStateChange(chatId)`.

Clear it on result, failure, cancellation and provider switch.

- [ ] **Step 4: Add draft to `ChatRuntime` / snapshot**

Keep it explicitly transient. No StoreEvent type is added.

- [ ] **Step 5: Render draft as the last active assistant block**

Do not create one React row per token. Render the accumulated string in one message surface and preserve Kanna's current autoscroll behavior.

Reasoning should use the existing reasoning/status presentation if one exists; otherwise render it in the same collapsed visual treatment used for agent reasoning elsewhere, not as normal assistant prose.

- [ ] **Step 6: Run tests**

```bash
bun test src/server/agent.test.ts src/server/read-models.test.ts src/client/app/KannaTranscript.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add src/server/harness-types.ts src/shared/types.ts src/server/agent.ts src/server/read-models.ts src/server/ws-router.ts src/client/app/useKannaState.ts src/client/app/KannaTranscript.tsx
git commit -m "feat: support live provider text drafts"
```

---

# Task 6: Implement `KimiCodeManager` session/turn lifecycle

**Files:**

- Create: `src/server/kimi-code.ts`
- Create: `src/server/kimi-code.test.ts`
- Reuse: `src/server/async-queue.ts`
- Reuse: `src/server/transcript.ts`
- Reuse: `src/shared/tools.ts`

- [ ] **Step 1: Define manager surface**

```ts
export class KimiCodeManager {
  ensureReady(): Promise<void>
  refreshModelCatalog(): Promise<boolean>
  checkSession(sessionId: string): Promise<"available" | "missing">

  startSession(args: {
    chatId: string
    cwd: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken?: string | null
    pendingForkSessionToken?: string | null
  }): Promise<{ sessionToken: string; resumeFellBack: boolean }>

  startTurn(args: {
    chatId: string
    content: string
    attachments: ChatAttachment[]
    model: string
    effort?: string
    planMode: boolean
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    onApprovalRequest: (request: HarnessApprovalRequest) => Promise<HarnessApprovalResponse>
  }): Promise<HarnessTurn>

  steer(args: {
    chatId: string
    content: string
    attachments: ChatAttachment[]
    model: string
    effort?: string
    planMode: boolean
  }): Promise<"steered" | "started_new_turn">

  listSkills(args: { chatId?: string; cwd: string }): Promise<HarnessSkill[] | null>
  closeChat(chatId: string): void
  stopAll(): void
}
```

- [ ] **Step 2: Write session tests first**

Cases:

1. No token -> `POST /sessions` with `metadata.cwd`, model, thinking effort, `permission_mode: "yolo"`, `plan_mode`.
2. Existing valid token -> `GET /sessions/{id}` and reuse it.
3. Missing token -> create a fresh session and return `resumeFellBack: true` so AgentCoordinator can emit `session_restored`.
4. `pendingForkSessionToken` -> `POST /sessions/{source}:fork`, return the new session id.
5. Same Kanna chat reuses its mapped Kimi session.
6. `closeChat` only detaches Kanna runtime listeners; it does not delete/archive the Kimi session.

- [ ] **Step 3: Write turn-start tests**

Assert exact prompt options:

```ts
{
  content: [{ type: "text", text: "..." }],
  model,
  thinking: effort,
  permission_mode: "yolo",
  plan_mode: planMode,
  prompt_id: expect.any(String),
}
```

When `startTurn` returns, immediately queue:

```ts
{ type: "session_token", sessionToken }
{ type: "transcript", entry: system_init(...) }
```

- [ ] **Step 4: Track prompt and main-turn identity**

Per chat/session context:

```ts
interface KimiChatContext {
  chatId: string
  sessionId: string
  cwd: string
  subscription: KimiSessionSubscription
  cursor?: KimiEventCursor
  pendingTurn: KimiPendingTurn | null
  closed: boolean
}

interface KimiPendingTurn {
  promptId: string
  mainTurnId?: number | string
  queue: AsyncQueue<HarnessEvent>
  text: KimiTextAccumulator
  tools: Map<string, KimiToolAccumulator>
  pendingInteractions: Map<string, KimiPendingInteraction>
  resolved: boolean
  cancelRequested: boolean
}
```

Background/subagent events must not overwrite `mainTurnId` or complete `pendingTurn`.

- [ ] **Step 5: Implement realtime event normalization**

Use small pure helpers in the same module or `kimi-code-normalize.ts` if the file becomes large:

```ts
normalizeKimiToolCall(...): NormalizedToolCall
kimiSystemInitEntry(...): TranscriptEntry
kimiTurnResult(...): TranscriptEntry
```

Prefer the same `NormalizedToolCall` kinds Kanna already understands. Unknown Kimi tools use the generic tool kind/name and retain a sanitized raw input only where Kanna's existing debug policy permits it.

- [ ] **Step 6: Handle tool results and context usage**

`GET /sessions/{id}/status` or status events can populate `context_window_updated`:

```ts
{
  usedTokens: context_tokens,
  maxTokens: max_context_tokens,
}
```

Do not invent a limit when Kimi reports it as unknown.

- [ ] **Step 7: Complete turns exactly once**

On `turn.ended` for the main active turn:

- flush the final assistant accumulator into one persisted `assistant_text` entry;
- clear live drafts;
- emit `result` with `isError` based on end reason;
- finish the `AsyncQueue` only after all durable terminal events for that prompt are consumed;
- tolerate a later duplicate `prompt.completed`/`prompt.aborted` without emitting a second result.

- [ ] **Step 8: Implement abort**

`HarnessTurn.interrupt()`:

1. `POST /sessions/{sid}/prompts/{pid}:abort`;
2. if that reports the prompt is already gone but the session is still busy, `POST /sessions/{sid}:abort`;
3. finish locally even if the HTTP call times out, because Kanna cancellation must remain responsive.

- [ ] **Step 9: Implement resync**

When `KimiEventConnection` reports a cursor or volatile-text gap:

1. mark the active turn as recovering;
2. call `GET /sessions/{id}/snapshot`;
3. rebuild text/tool/interactions from the snapshot/transcript state;
4. set the fresh `{seq, epoch}` cursor;
5. resume subscription;
6. never duplicate transcript rows already persisted by Kanna.

Write a regression test where an assistant delta is missed and the recovered final transcript contains the complete text exactly once.

- [ ] **Step 10: Run tests**

```bash
bun test src/server/kimi-code.test.ts
```

- [ ] **Step 11: Commit**

```bash
git add src/server/kimi-code.ts src/server/kimi-code.test.ts
git commit -m "feat: add Kimi Code session and turn manager"
```

---

# Task 7: Generalize human interactions for Kimi approvals and questions

**Files:**

- Modify: `src/server/harness-types.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/server/agent.ts`
- Modify: `src/server/ws-router.ts`
- Modify: `src/client/components/messages/*` for approval UI
- Test: `src/server/agent.test.ts`
- Test: relevant client interaction component tests

Kanna currently gives `HarnessToolRequest` first-class treatment to `AskUserQuestion` and `ExitPlanMode`. Kimi can also ask for ordinary/sensitive tool approval even in YOLO mode. Add a provider-neutral approval type instead of hiding Kimi's request.

- [ ] **Step 1: Add failing approval-state tests**

Prove Kanna can represent:

```ts
interface HarnessApprovalRequest {
  id: string
  toolId: string
  toolName: string
  action: string
  input: unknown
  options: Array<{
    id: "approve" | "approve_session" | "reject" | "cancel"
    label: string
  }>
  planExit?: {
    plan?: string
    options?: Array<{ label: string; description?: string }>
  }
}
```

- [ ] **Step 2: Extend active interaction state**

Replace `pendingTool: PendingToolRequest | null` with a discriminated `pendingInteraction` that covers:

```ts
"ask_user_question"
"exit_plan_mode"
"approval"
```

Keep the existing snapshot field compatible if possible; otherwise bump only Kanna's internal wire/snapshot protocol that truly needs it and add migration/default handling.

- [ ] **Step 3: Map Kimi approval decisions**

Kanna response -> Kimi:

```text
Approve once       -> { decision: "approved" }
Approve session    -> { decision: "approved", scope: "session" }
Reject             -> { decision: "rejected", feedback?: "..." }
Cancel             -> { decision: "cancelled" }
Plan option choice -> approved + selected_label when Kimi offered labels
```

- [ ] **Step 4: Map Kimi questions to existing AskUserQuestion UI**

Kimi question options have stable ids. Preserve them through normalization so answers can be returned exactly:

```ts
{
  answers: {
    [questionItem.id]:
      | { kind: "single", option_id: "..." }
      | { kind: "multi", option_ids: ["..."] }
      | { kind: "other", text: "..." }
      | { kind: "skipped" }
  }
}
```

Do not answer by display label; labels are not stable identifiers.

- [ ] **Step 5: Plan-exit approval**

When the approval represents `ExitPlanMode`, render Kanna's existing plan approval treatment rather than a generic command dialog. On approval, clear Kanna `planMode` in the same place existing Codex/Claude plan approval does so the next composer state is consistent.

- [ ] **Step 6: Cancellation while waiting for user**

If the user hits Stop while an approval/question is pending:

- append the appropriate Kanna cancelled/discarded tool result;
- resolve/dismiss the Kimi interaction where possible;
- abort the active prompt;
- guarantee no unresolved local promise remains.

- [ ] **Step 7: Run tests**

```bash
bun test src/server/agent.test.ts
bun test src/client/components/messages
```

- [ ] **Step 8: Commit**

```bash
git add src/server/harness-types.ts src/shared/types.ts src/shared/protocol.ts src/server/agent.ts src/server/ws-router.ts src/client/components/messages
git commit -m "feat: support provider approval interactions"
```

---

# Task 8: Wire Kimi into `AgentCoordinator`

**Files:**

- Modify: `src/server/agent.ts`
- Modify: `src/server/session-artifacts.ts`
- Modify: server bootstrap dependency wiring
- Test: `src/server/agent.test.ts`
- Test: `src/server/session-artifacts.test.ts`

- [ ] **Step 1: Inject `KimiCodeManager`**

Add:

```ts
kimiManager?: KimiCodeManager
```

to `AgentCoordinatorArgs`, with a real default instance for production and fake injection in tests.

- [ ] **Step 2: Add Kimi provider settings**

In `getProviderSettings`:

```ts
if (provider === "kimi") {
  const model = normalizeServerModel(provider, options.model)
  const modelOptions = normalizeKimiModelOptions(model, options.modelOptions, options.effort)
  return {
    model,
    effort: modelOptions.reasoningEffort,
    serviceTier: undefined,
    planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
    autoPlan: false,
  }
}
```

- [ ] **Step 3: Add provider-handoff cleanup**

In `prepareProviderHandoff`:

```ts
this.kimiManager.closeChat(chatId)
```

Clear Kanna's session tokens as today. Do not archive the old Kimi session.

- [ ] **Step 4: Detect missing Kimi sessions**

In `detectLostProviderSession`, add a Kimi branch using `kimiManager.checkSession(sessionToken)`. A missing session returns true; transport/auth errors return false so `startTurn` can surface the real provider error rather than pretending the session vanished.

- [ ] **Step 5: Add Kimi turn dispatch**

Before the Codex fallback branch in `startTurnForChat`:

```ts
} else if (args.provider === "kimi") {
  const started = await this.kimiManager.startSession({ ... })
  // clear pending fork token when a fork produced a new Kimi session id
  turn = await this.kimiManager.startTurn({ ... })
}
```

Use `buildPromptText(wireContent, attachments)` or native content parts from Task 11 when attachments are implemented.

- [ ] **Step 6: Preserve provider-neutral `runTurn`**

Do not add Kimi raw-event handling to `runTurn`. `KimiCodeManager` must already emit `HarnessEvent`.

Add only the new `live_text_delta` generic branch.

- [ ] **Step 7: Close Kimi resources**

`closeChat` calls `kimiManager.closeChat(chatId)`.

Global server shutdown calls `kimiManager.stopAll()` / server process `stop()`.

- [ ] **Step 8: Run tests**

```bash
bun test src/server/agent.test.ts src/server/session-artifacts.test.ts
```

- [ ] **Step 9: Commit**

```bash
git add src/server/agent.ts src/server/session-artifacts.ts
git commit -m "feat: route Kimi turns through AgentCoordinator"
```

---

# Task 9: Use Kimi native steer instead of cancel-and-restart

**Files:**

- Modify: `src/server/harness-types.ts`
- Modify: `src/server/kimi-code.ts`
- Modify: `src/server/agent.ts`
- Test: `src/server/kimi-code.test.ts`
- Test: `src/server/agent.test.ts`

Kanna currently implements `message.steer` by cancelling the active turn and launching the queued message as a new turn. Kimi has a native steer primitive; use it so Kimi can accept feedback mid-turn like a rich Codex-style client.

- [ ] **Step 1: Add an optional native steer capability**

```ts
interface HarnessTurn {
  // existing fields
  steer?: (input: {
    content: string
    attachments: ChatAttachment[]
    model?: string
    effort?: string
    planMode?: boolean
  }) => Promise<"steered" | "started_new_turn">
}
```

Only Kimi implements it in this plan. Existing providers keep their current behavior.

- [ ] **Step 2: Implement Kimi steer protocol**

While a prompt is active:

1. `POST /sessions/{sid}/prompts` with the user's new content and current Kanna settings.
2. If response `status === "queued"`, call `POST /sessions/{sid}/prompts/{newPromptId}:steer`.
3. Keep the existing `HarnessTurn` and event subscription alive.
4. Return `"steered"`.

The Kanna transcript appends a `user_prompt` with `steered: true` once the server accepts the steer.

- [ ] **Step 3: Handle the completion race**

If step 1 returns `status === "running"`, the previous prompt completed between the Kanna click and Kimi request. Return `"started_new_turn"` and rebind the manager's pending prompt identity to the new prompt without losing events. AgentCoordinator must not also start a second prompt.

Write this race as a deterministic unit test.

- [ ] **Step 4: Change `AgentCoordinator.steer`**

If the current turn has `turn.steer`:

- remove the queued Kanna message only after native steer succeeds;
- append the steered user prompt;
- do not call `cancel()`;
- preserve the active turn status.

Otherwise retain Kanna's existing cancel-and-restart path exactly.

- [ ] **Step 5: Run tests**

```bash
bun test src/server/kimi-code.test.ts src/server/agent.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/server/harness-types.ts src/server/kimi-code.ts src/server/agent.ts
git commit -m "feat: steer active Kimi turns"
```

---

# Task 10: Dynamic Kimi models, efforts and context windows

**Files:**

- Modify: `src/server/kimi-code.ts`
- Modify: `src/server/provider-catalog.ts`
- Modify: `src/client/components/chat-ui/ChatPreferenceControls.tsx`
- Modify: `src/client/stores/chatPreferencesStore.ts`
- Test: provider catalog/preferences tests
- Test: chat preference component tests

- [ ] **Step 1: Fetch Kimi model catalog after readiness**

Call:

```text
GET /api/v1/models
```

Map fields:

```text
model             -> Kanna model id
provider          -> retained for diagnostics only
display_name       -> label
max_context_size   -> contextWindowTokens
support_efforts    -> model-specific effort picker
default_effort     -> defaultReasoningEffort
capabilities       -> future capability flags
```

- [ ] **Step 2: Make effort selection model-specific**

K3 currently may advertise only `max`; other configured Kimi models/providers may advertise different effort strings. The picker must use the selected model's `supportedReasoningEfforts` when present, not a global hard-coded list.

- [ ] **Step 3: Refresh after auth/config changes**

Refresh the model catalog:

- after Kimi server readiness;
- after successful Kimi login;
- after a provider/config refresh event if Kimi broadcasts one;
- on the first Kimi turn if catalog loading previously failed.

- [ ] **Step 4: Context meter**

Set `contextWindowTokens` from `max_context_size`. During a live session, prefer Kimi `status.max_context_tokens` if it is available and differs from the catalog, because the runtime session is authoritative.

- [ ] **Step 5: Tests**

Include:

- K3 max-only effort;
- a custom model with `low/medium/high`;
- a model with no `support_efforts` (hide effort picker);
- no model list (retain static fallback without crashing).

- [ ] **Step 6: Commit**

```bash
git add src/server/kimi-code.ts src/server/provider-catalog.ts src/client/components/chat-ui/ChatPreferenceControls.tsx src/client/stores/chatPreferencesStore.ts
git commit -m "feat: discover Kimi models and effort levels"
```

---

# Task 11: Kimi skills and attachments

**Files:**

- Modify: `src/server/agent.ts`
- Modify: `src/server/harness-skills.ts`
- Modify: `src/server/kimi-code.ts`
- Test: `src/server/harness-skills.test.ts`
- Test: `src/server/kimi-code.test.ts`

- [ ] **Step 1: Skills**

Prefer Kimi's live session skill catalog through:

```text
GET /api/v1/sessions/{session_id}/skills
```

If no session exists, use the workspace skill endpoint when a workspace id is available. If neither is available, scan the Kimi-compatible skill roots documented by the installed Kimi version.

Normalize to `HarnessSkill`.

- [ ] **Step 2: Add `listSkills` provider branch**

`AgentCoordinator.listSkills` returns:

```ts
{ provider: "kimi", skills, origin: "live" }
```

when API enumeration succeeds; otherwise a filesystem fallback.

- [ ] **Step 3: Text-only attachment fallback test**

Before native Kimi content parts are wired, verify Kanna's existing `<kanna-attachments>` prompt hint still lets Kimi access files already placed in the sandbox filesystem.

- [ ] **Step 4: Native media/file content parts**

Inspect the live Kimi OpenAPI `PromptSubmission.content` schema and map Kanna `ChatAttachment` to native parts for the installed Kimi version. Keep `buildPromptText` only as fallback for unsupported attachment types.

Do not guess media-part fields from old SDK versions.

- [ ] **Step 5: Security**

Kimi's server exposes powerful file endpoints. Kanna does not proxy generic `/fs:content` to the browser. Attachment access remains constrained to Kanna's existing project/upload path policy and the sandbox boundary.

- [ ] **Step 6: Run tests**

```bash
bun test src/server/harness-skills.test.ts src/server/kimi-code.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/server/agent.ts src/server/harness-skills.ts src/server/kimi-code.ts
git commit -m "feat: add Kimi skills and attachment support"
```

---

# Task 12: Provider discovery, install/auth status and setup UI

**Files:**

- Modify: `src/server/provider-auth.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/client/stores/providerAuthStore.ts`
- Modify: `src/client/app/settings/ProvidersSection.tsx`
- Modify: `src/client/components/auth/SetupWizard.tsx`
- Modify: `src/client/components/provider-icons.tsx`
- Test: provider auth/server/client tests

- [ ] **Step 1: Add Kimi to provider/auth ids**

Kimi readiness has three states that must be distinguishable:

```text
binary missing
server reachable but auth/provider not ready
ready
```

Do not conflate "kimi exists on PATH" with "a usable Kimi model is configured".

- [ ] **Step 2: Binary discovery**

Use `kimi --version` only for installation/version display. Runtime/auth state comes from Kimi Server API.

- [ ] **Step 3: Install action**

If Kanna currently offers install buttons for provider CLIs, add Kimi using the official published CLI package:

```bash
npm install -g @moonshot-ai/kimi-code
```

or the project's established package-manager abstraction. Do not shell-pipe a remote install script from inside Kanna.

- [ ] **Step 4: Auth status**

After server readiness call:

```text
GET /api/v1/auth
```

Show a provider-specific state instead of trying to infer auth by reading Kimi credential files.

- [ ] **Step 5: Interactive OAuth/login**

Implement Kimi login through the server endpoints:

```text
POST   /api/v1/oauth/login
GET    /api/v1/oauth/login
DELETE /api/v1/oauth/login
POST   /api/v1/oauth/logout
```

Render the device-code/login URL state returned by the live API. Poll only while the setup dialog is active, stop on completion/cancel, then refresh auth + model catalog.

If the installed Kimi server does not advertise those paths, display a fallback instruction to run `kimi login` in the sandbox terminal; do not invent a private credential flow.

- [ ] **Step 6: Provider icon and labels**

Add a Kimi provider icon through the same component API as other providers. Avoid importing branding assets whose license is unclear; use a simple text/neutral glyph if the repository has no permitted asset.

- [ ] **Step 7: Run tests**

```bash
bun test src/server/provider-auth.test.ts src/client/stores/providerAuthStore.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/server/provider-auth.ts src/shared/types.ts src/shared/protocol.ts src/client/stores/providerAuthStore.ts src/client/app/settings/ProvidersSection.tsx src/client/components/auth/SetupWizard.tsx src/client/components/provider-icons.tsx
git commit -m "feat: add Kimi provider setup and auth"
```

---

# Task 13: Complete exhaustive provider branches across Kanna

**Files:**

Audit and modify every exhaustive provider switch / `Record<AgentProvider, ...>`, including at minimum:

- `src/client/components/provider-icons.tsx`
- `src/client/stores/providerAuthStore.ts`
- `src/client/app/settings/ProvidersSection.tsx`
- `src/client/lib/composer.ts`
- `src/client/app/kannaStateHelpers.ts`
- `src/client/app/useAppSettingsSync.ts`
- `src/server/app-settings.ts`
- `src/client/stores/chatPreferencesStore.ts`
- `src/client/components/chat-ui/ChatPreferenceControls.tsx`
- `src/server/discovery.ts`
- `src/server/quick-response.ts`
- `src/server/handoff.ts`
- `src/server/read-models.ts`
- `src/server/harness-skills.ts`
- `src/server/usage-limits.ts`
- `src/server/generate-title.ts`
- `src/server/generate-commit-message.ts`
- `src/server/session-artifacts.ts`

- [ ] **Step 1: Let TypeScript find the exhaustive set**

```bash
bunx tsc --noEmit
```

Do not weaken exhaustive types to `string` or add wildcard fallthroughs just to make compilation pass.

- [ ] **Step 2: Decide each Kimi behavior deliberately**

Rules:

- title generation / quick-response helper: continue using the existing dedicated lightweight provider unless Kanna explicitly routes these through the active harness; Kimi support here is not required merely because the chat provider is Kimi;
- handoff: Kimi participates exactly like other providers;
- usage limits: return Kimi usage only if the public server API provides a semantically equivalent account limit; otherwise return unsupported/null, not fabricated data;
- discovery: add Kimi native session discovery only if Kanna exposes external provider histories; do not block core Kimi chat support on it;
- session artifacts: Kimi uses API existence probing rather than filesystem assumptions.

- [ ] **Step 3: Run TypeScript until no Kimi exhaustiveness errors remain**

```bash
bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src
git commit -m "chore: complete Kimi provider integration branches"
```

---

# Task 14: End-to-end tests against a fake Kimi server

**Files:**

- Create: `src/server/kimi-code.e2e.test.ts`
- Create: `src/server/test-utils/fake-kimi-server.ts`

The fake server must speak the subset of Kimi REST + WebSocket that Kanna consumes. Do not make unit tests depend on a real Kimi account.

- [ ] **Step 1: Happy-path real-time chat**

Test flow:

```text
create Kanna chat
-> Kimi session created
-> WS subscribed
-> prompt submitted
-> turn.started
-> assistant.delta
-> tool.call.started
-> tool.result
-> assistant.delta
-> turn.ended
-> Kanna result success
```

Assert:

- one Kimi session token persisted;
- live text visible before turn end;
- final assistant transcript has complete text once;
- tool call/result pair hydrates correctly;
- chat returns to idle.

- [ ] **Step 2: Question flow**

Fake `event.question.requested`, answer from the Kanna command path, assert exact option ids reach `POST /questions/{id}`.

- [ ] **Step 3: Approval flow**

Fake a sensitive-tool approval and Plan-exit approval. Assert approve-once, session-scope approve, reject and selected plan label payloads.

- [ ] **Step 4: Native steer**

Submit a second Kanna message while turn one is running, invoke `message.steer`, assert:

- no abort request is sent;
- Kimi queued prompt is promoted with `:steer`;
- first turn stays active;
- transcript marks second user message `steered: true`.

- [ ] **Step 5: Browser/Kanna event reconnect**

Drop the Kimi WebSocket mid-turn, reconnect with cursor, replay durable events, then finish. Assert no duplicated tool/result or assistant content.

- [ ] **Step 6: Resync required**

Return `resync_required`; provide a snapshot that contains progress past Kanna's cursor; assert the adapter repairs state and finishes normally.

- [ ] **Step 7: Session missing/restore**

Persist a fake session id in Kanna, make `GET /sessions/{id}` return session-not-found, then send a new message. Assert:

- Kanna clears stale token;
- emits `session_restored` boundary;
- creates a new Kimi session;
- prepends existing handoff context exactly once.

- [ ] **Step 8: Fork**

Fork idle Kanna chat, then send from fork. Assert Kimi receives `POST /sessions/{source}:fork` and Kanna stores the returned new session id.

- [ ] **Step 9: Run E2E test**

```bash
bun test src/server/kimi-code.e2e.test.ts
```

- [ ] **Step 10: Commit**

```bash
git add src/server/kimi-code.e2e.test.ts src/server/test-utils/fake-kimi-server.ts
git commit -m "test: cover Kimi realtime chat flows"
```

---

# Task 15: Real-runtime smoke test in an isolated Kimi home

**Files:**

- Create: `scripts/smoke-kimi.ts`
- Modify: `package.json`
- Create: `docs/kimi-code.md`

This test is manual/opt-in and may use an authenticated developer Kimi account. It must never run in CI by default.

- [ ] **Step 1: Add an isolated smoke command**

Use a temporary or explicitly provided Kimi home so the smoke test does not mutate a developer's normal sessions unless requested:

```text
KANNA_KIMI_SMOKE=1
KIMI_CODE_HOME=<test directory>
```

Script flow:

1. start/attach to `kimi web --no-open`;
2. check protocol compatibility;
3. create a temporary session in a temporary git repo;
4. submit "Create hello.txt containing hello";
5. observe live events;
6. assert file creation;
7. submit a second prompt in the same session;
8. cancel a third prompt;
9. close without exposing the token.

- [ ] **Step 2: Add package script**

```json
"test:kimi-smoke": "KANNA_KIMI_SMOKE=1 bun run ./scripts/smoke-kimi.ts"
```

- [ ] **Step 3: Document deployment modes**

`docs/kimi-code.md` covers:

```text
Mode A: Kanna spawns `kimi web --no-open` inside the same sandbox.
Mode B: sandbox supervisor starts Kimi; Kanna receives KANNA_KIMI_SERVER_URL/TOKEN.
```

For the company Web-platform architecture, recommend Mode B when the sandbox orchestrator already owns process lifetime; otherwise Mode A is self-contained.

Document that the Kimi server must remain loopback-only from the sandbox's perspective and only Kanna's authenticated WebSocket/API is exposed to the company frontend.

- [ ] **Step 4: Run smoke test manually**

```bash
bun run test:kimi-smoke
```

Expected: same Kimi session handles multiple turns; realtime deltas/tool events arrive; cancel works; no bearer token appears in stdout.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-kimi.ts package.json docs/kimi-code.md
git commit -m "docs: add Kimi runtime smoke test and deployment guide"
```

---

# Task 16: Full regression and release gate

**Files:**

- Modify only files required by failures found here.

- [ ] **Step 1: Run all unit/integration tests**

```bash
bun test
```

Expected: pass.

- [ ] **Step 2: Typecheck and build**

```bash
bun run check
```

Expected: TypeScript, client build and export-viewer build all pass.

- [ ] **Step 3: Verify provider regression matrix manually**

Run at least one turn with each installed provider:

```text
Claude Code
Codex
Cursor
Pi
Kimi Code
```

For Kimi verify:

```text
new chat
second turn resumes session
live assistant text
live tool activity
question
Plan mode approval
Stop
native steer
fork
browser refresh during running turn
Kimi WS reconnect/resync
provider switch Kimi -> Codex -> Kimi creates fresh Kimi native context as Kanna handoff semantics require
```

- [ ] **Step 4: Security review**

Search for accidental token exposure:

```bash
rg "KANNA_KIMI_SERVER_TOKEN|server\.token|kimi-code\.bearer|Authorization: Bearer" src docs scripts
```

Review every hit. Expected: only controlled server-side transport/config code; no client bundle, snapshot or analytics path contains token material.

Verify Kimi server launch arguments do not contain:

```text
--host 0.0.0.0
--dangerous-bypass-auth
```

- [ ] **Step 5: Check production client bundle for server-only Kimi symbols**

```bash
bun run build:client
rg "KANNA_KIMI_SERVER_TOKEN|kimi-code\.bearer" dist/client
```

Expected: no matches.

- [ ] **Step 6: Final commit if release-gate fixes were needed**

```bash
git add -A
git commit -m "fix: complete Kimi integration release gate"
```

Skip this commit if there are no changes.

---

## 4. Recommended implementation order / merge checkpoints

Keep the work reviewable. The intended checkpoints are:

1. Provider types/preferences/catalog.
2. Kimi server process lifecycle.
3. REST client + compatibility probe.
4. Shared WebSocket event connection.
5. Provider-neutral live text draft support.
6. Kimi session/turn manager.
7. Generic approval/question interaction support.
8. AgentCoordinator integration.
9. Native Kimi steer.
10. Dynamic model/effort/context catalog.
11. Skills/attachments.
12. Setup/auth UI.
13. Exhaustive provider cleanup.
14. Fake-server E2E.
15. Real-runtime smoke/doc.
16. Full regression/security gate.

Do not squash these while developing. They isolate protocol plumbing from UI and make provider regressions bisectable.

---

## 5. Key implementation invariants

These are acceptance rules, not suggestions.

### Runtime ownership

- One Kimi server connection per Kanna backend/sandbox by default.
- Many Kanna chats may map to many Kimi sessions over that one server.
- One shared Kimi WS connection multiplexes subscriptions.
- Browser disconnect never kills Kimi.

### Session truth

- Kanna `sessionToken` stores only the Kimi session id.
- Kimi's server remains authoritative for native session existence and runtime state.
- Kanna's EventStore remains authoritative for the Kanna transcript/handoff history.
- A missing Kimi native session is recovered through Kanna's existing restore/handoff mechanism; Kanna never silently pretends the old context was resumed.

### Event truth

- Durable Kimi `seq`/`epoch` is used only for Kanna<->Kimi replay.
- Kanna EventStore ids are independent; do not reuse Kimi seq as a Kanna message id.
- Volatile Kimi deltas are ephemeral and offset-checked.
- Final transcript content is persisted once.
- Background/subagent events cannot complete the main Kanna turn.

### Security

- Kimi server token is backend-only and memory-resident where possible.
- Never send `/api/v1/fs:content` as a generic browser proxy.
- Never make the Kimi server the company-facing auth boundary; the company/Kanna platform owns auth/RBAC and sandbox selection.
- Treat a Kimi server token as full control of that sandbox's Kimi sessions, filesystem and shell.

### API compatibility

- The Kimi local Server API is experimental.
- Check live OpenAPI/AsyncAPI capability at runtime.
- Unknown new events are ignored/logged safely; unknown required response shapes fail explicitly.
- No fallback to terminal-output scraping.

---

## 6. Acceptance checklist

- [ ] `AgentProvider` includes `kimi` without weakening exhaustive provider typing.
- [ ] Kimi provider appears in provider/model UI.
- [ ] Kimi binary/server/auth readiness is visible in setup.
- [ ] Kanna can spawn `kimi web --no-open` or attach to a sandbox-managed Kimi server.
- [ ] Kimi bearer token never reaches browser/client state.
- [ ] New Kanna Kimi chat creates one Kimi session.
- [ ] Subsequent turns reuse it.
- [ ] Kanna chat fork uses Kimi session fork.
- [ ] Missing Kimi session triggers Kanna conversation restore boundary.
- [ ] Assistant output streams before turn completion.
- [ ] Final assistant text persists exactly once.
- [ ] Thinking/reasoning is streamed without becoming normal answer text.
- [ ] Tool calls/results render through Kanna's normalized tool UI.
- [ ] Questions are answerable from Kanna.
- [ ] Sensitive approvals are answerable from Kanna.
- [ ] Plan mode can be entered and ExitPlanMode can be approved/rejected from Kanna.
- [ ] Full Access uses `yolo`, not `auto`.
- [ ] Stop is responsive even if Kimi abort transport hangs.
- [ ] `message.steer` uses Kimi native steering and does not cancel the active turn.
- [ ] Kimi WS reconnect replays durable missed events using cursors.
- [ ] `resync_required` / volatile offset gaps recover through snapshot/transcript rebuild.
- [ ] Kimi models/efforts/context windows are discovered dynamically.
- [ ] Skills list works live or via documented fallback.
- [ ] Attachments work through native content parts where advertised, with Kanna file-path fallback otherwise.
- [ ] `bun test` passes.
- [ ] `bun run check` passes.
- [ ] Production client bundle contains no Kimi server credential strings.
- [ ] Existing Claude/Codex/Cursor/Pi behavior is unchanged.

---

## 7. Why this integration boundary

The current Kimi Code local server is already the UI-facing control plane that Kimi's own browser client uses. It exposes exactly the primitives Kanna needs: persistent sessions, queued prompts, native steering, prompt/session abort, approvals, questions, dynamic models, transcript/snapshot reads, and a replayable WebSocket stream. Integrating at that boundary avoids reconstructing a rich client from terminal output and avoids binding Kanna to an internal SDK package whose release status can change independently of the CLI.

The resulting layering stays consistent with Kanna's existing architecture:

```text
React Kanna UI
      |
      v
Kanna shared protocol / snapshots
      |
      v
AgentCoordinator
      |
      +-- Claude Agent SDK
      +-- Codex app-server
      +-- Cursor CLI manager
      +-- Pi manager
      +-- KimiCodeManager
              |
              +-- Kimi REST API
              +-- Kimi WS events
                      |
                      v
                 kimi web
```

Kimi-specific protocol logic ends at `KimiCodeManager`. Everything above it remains provider-neutral.
