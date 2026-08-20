import { describe, expect, test } from "bun:test"
import { KimiApiError, KimiCodeApi, type KimiPromptSubmission } from "./kimi-code-api"
import { KimiCodeServerProcess, type KimiServerConnection } from "./kimi-code-server"
import { KimiEventConnection, type KimiEventHandlers, type KimiWsEvent } from "./kimi-code-events"
import {
  KimiCodeManager,
  kimiSystemInitEntry,
  kimiTurnResult,
  normalizeKimiToolCall,
  type HarnessApprovalResponse,
} from "./kimi-code"

class FakeKimiCodeServerProcess extends KimiCodeServerProcess {
  constructor(private readonly connection: KimiServerConnection = { baseUrl: "http://127.0.0.1:8080", token: "test-token", owned: true }) {
    super()
  }

  override ensureReady(): Promise<KimiServerConnection> {
    return Promise.resolve(this.connection)
  }

  override stop(): void {}
}

class FakeKimiCodeApi extends KimiCodeApi {
  calls: Array<{ method: string; args: unknown[] }> = []
  private sessions = new Map<string, { metadata?: Record<string, unknown>; model?: string; thinking?: string; permission_mode?: string; plan_mode?: boolean }>()
  private nextSessionId = 1

  constructor() {
    super({ baseUrl: "http://127.0.0.1:8080", token: "test-token" })
  }

  override async createSession(body?: { metadata?: Record<string, unknown>; model?: string; thinking?: string; permission_mode?: string; plan_mode?: boolean }): Promise<import("./kimi-code-api").KimiSession> {
    this.calls.push({ method: "createSession", args: [body] })
    const id = `session_${this.nextSessionId++}`
    this.sessions.set(id, body ?? {})
    return { id, metadata: body?.metadata }
  }

  override async getSession(sessionId: string): Promise<import("./kimi-code-api").KimiSession> {
    this.calls.push({ method: "getSession", args: [sessionId] })
    if (!this.sessions.has(sessionId)) {
      throw new KimiApiError("session not found", { code: 4_040_404, status: 404 })
    }
    return { id: sessionId }
  }

  override async forkSession(sessionId: string): Promise<import("./kimi-code-api").KimiSession> {
    this.calls.push({ method: "forkSession", args: [sessionId] })
    const id = `session_${this.nextSessionId++}`
    this.sessions.set(id, { metadata: { forkedFrom: sessionId } })
    return { id }
  }

  override async submitPrompt(sessionId: string, prompt: KimiPromptSubmission): Promise<import("./kimi-code-api").KimiPromptItem> {
    this.calls.push({ method: "submitPrompt", args: [sessionId, prompt] })
    return { id: `prompt_${Date.now()}`, status: "running" }
  }

  override async steerPrompt(sessionId: string, promptId: string): Promise<void> {
    this.calls.push({ method: "steerPrompt", args: [sessionId, promptId] })
  }

  override async abortPrompt(sessionId: string, promptId: string): Promise<void> {
    this.calls.push({ method: "abortPrompt", args: [sessionId, promptId] })
  }

  override async abortSession(sessionId: string): Promise<{ aborted: boolean }> {
    this.calls.push({ method: "abortSession", args: [sessionId] })
    return { aborted: true }
  }

  override async answerQuestion(sessionId: string, questionId: string, response: unknown): Promise<void> {
    this.calls.push({ method: "answerQuestion", args: [sessionId, questionId, response] })
  }

  override async resolveApproval(sessionId: string, approvalId: string, response: unknown): Promise<void> {
    this.calls.push({ method: "resolveApproval", args: [sessionId, approvalId, response] })
  }

  override async listModels(): Promise<import("./kimi-code-api").KimiModelItem[]> {
    this.calls.push({ method: "listModels", args: [] })
    return []
  }

  override async getAuth(): Promise<import("./kimi-code-api").KimiAuthSnapshot> {
    return { signed_in: false }
  }

  seedSession(sessionId: string, body?: { metadata?: Record<string, unknown> }) {
    this.sessions.set(sessionId, body ?? {})
  }
}

class FakeKimiEventConnection extends KimiEventConnection {
  private handlersBySession = new Map<string, KimiEventHandlers>()

  constructor() {
    super({ baseUrl: "http://127.0.0.1:8080", token: "test-token" })
  }

  override start(): Promise<void> {
    return Promise.resolve()
  }

  override subscribe(sessionId: string, handlers: KimiEventHandlers): { close(): void } {
    this.handlersBySession.set(sessionId, handlers)
    return {
      close: () => {
        this.handlersBySession.delete(sessionId)
      },
    }
  }

  emit(sessionId: string, event: KimiWsEvent) {
    this.handlersBySession.get(sessionId)?.onEvent(event)
  }

  resync(sessionId: string) {
    this.handlersBySession.get(sessionId)?.onResyncRequired()
  }

  override close(): void {
    this.handlersBySession.clear()
  }
}

async function collectStream(stream: AsyncIterable<import("./harness-types").HarnessEvent>) {
  const items: import("./harness-types").HarnessEvent[] = []
  for await (const item of stream) {
    items.push(item)
  }
  return items
}

function managerWithFakes() {
  const server = new FakeKimiCodeServerProcess()
  const api = new FakeKimiCodeApi()
  const events = new FakeKimiEventConnection()
  const manager = new KimiCodeManager({ server, api, events })
  return { manager, server, api, events }
}

describe("KimiCodeManager", () => {
  test("creates a new session when no token is provided", async () => {
    const { manager, api } = managerWithFakes()
    const result = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      effort: "max",
      planMode: false,
    })

    expect(result.resumeFellBack).toBe(false)
    expect(result.sessionToken).toMatch(/^session_/)

    const createCall = api.calls.find((call) => call.method === "createSession")
    expect(createCall?.args[0]).toMatchObject({
      metadata: { cwd: "/tmp/project" },
      model: "kimi-code/k3",
      thinking: "max",
      permission_mode: "yolo",
      plan_mode: false,
    })
  })

  test("reuses an existing session token when valid", async () => {
    const { manager, api } = managerWithFakes()
    api.seedSession("session_existing")

    const result = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
      sessionToken: "session_existing",
    })

    expect(result.sessionToken).toBe("session_existing")
    expect(result.resumeFellBack).toBe(false)
    expect(api.calls.some((call) => call.method === "createSession")).toBe(false)
    expect(api.calls.some((call) => call.method === "getSession" && call.args[0] === "session_existing")).toBe(true)
  })

  test("falls back to a fresh session when the stored session is missing", async () => {
    const { manager, api } = managerWithFakes()

    const result = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
      sessionToken: "session_missing",
    })

    expect(result.resumeFellBack).toBe(true)
    expect(result.sessionToken).not.toBe("session_missing")
    expect(api.calls.some((call) => call.method === "createSession")).toBe(true)
  })

  test("forks a session when a pending fork token is provided", async () => {
    const { manager, api } = managerWithFakes()
    api.seedSession("session_source")

    const result = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
      sessionToken: "session_source",
      pendingForkSessionToken: "session_source",
    })

    expect(result.sessionToken).not.toBe("session_source")
    expect(api.calls.some((call) => call.method === "forkSession" && call.args[0] === "session_source")).toBe(true)
  })

  test("reuses the same Kimi session for the same chat", async () => {
    const { manager, api } = managerWithFakes()

    const first = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
    })

    const second = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
      sessionToken: first.sessionToken,
    })

    expect(second.sessionToken).toBe(first.sessionToken)
    expect(api.calls.filter((call) => call.method === "createSession").length).toBe(1)
  })

  test("closeChat detaches listeners without deleting the server session", async () => {
    const { manager, api } = managerWithFakes()
    const { sessionToken } = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
    })

    manager.closeChat("chat-1")

    expect(api.calls.some((call) => call.method === "abortSession")).toBe(false)
    expect(api.calls.some((call) => call.method.startsWith("delete"))).toBe(false)
    expect(sessionToken).toMatch(/^session_/)
  })

  test("startTurn submits the prompt with exact options", async () => {
    const { manager, api, events } = managerWithFakes()
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: true,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Hello",
      attachments: [],
      model: "kimi-code/k3",
      effort: "max",
      planMode: true,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    const submitCall = api.calls.find((call) => call.method === "submitPrompt")
    expect(submitCall?.args[1]).toMatchObject({
      content: [{ type: "text", text: "Hello" }],
      model: "kimi-code/k3",
      thinking: "max",
      permission_mode: "yolo",
      plan_mode: true,
      prompt_id: expect.any(String),
    })

    events.emit("session_1", { type: "turn.started", data: { turn_id: "turn_1" } })
    events.emit("session_1", { type: "assistant.delta", data: {}, text: "Hi", offset: 0 })
    events.emit("session_1", { type: "turn.ended", data: { reason: "completed" } })

    const stream = await collectStream(turn.stream)
    expect(stream[0]).toEqual({ type: "session_token", sessionToken: "session_1" })
    expect(stream[1].type).toBe("transcript")
    expect(stream[1].entry?.kind).toBe("system_init")
    if (stream[1].type === "transcript" && stream[1].entry?.kind === "system_init") {
      expect(stream[1].entry.provider).toBe("kimi")
      expect(stream[1].entry.model).toBe("kimi-code/k3")
    }
    expect(stream.some((event) => event.type === "live_text_delta")).toBe(true)
    expect(stream.some((event) => event.type === "transcript" && event.entry?.kind === "assistant_text")).toBe(true)
    expect(stream.some((event) => event.type === "transcript" && event.entry?.kind === "result")).toBe(true)
  })

  test("normalizes tool call and result events", async () => {
    const { manager, events } = managerWithFakes()
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "kimi-code/k3", planMode: false })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Run pwd",
      attachments: [],
      model: "kimi-code/k3",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    events.emit("session_1", { type: "tool.call.started", data: { tool_id: "t1", tool: "Bash", input: { command: "pwd" } } })
    events.emit("session_1", { type: "tool.result", data: { tool_id: "t1", output: "/tmp/project" } })
    events.emit("session_1", { type: "turn.ended", data: { reason: "completed" } })

    const stream = await collectStream(turn.stream)
    const toolCall = stream.find((event) => event.type === "transcript" && event.entry?.kind === "tool_call")
    const toolResult = stream.find((event) => event.type === "transcript" && event.entry?.kind === "tool_result")

    expect(toolCall).toBeDefined()
    expect(toolResult).toBeDefined()
  })

  test("abort finishes the turn even if the abort request fails", async () => {
    const { manager, api } = managerWithFakes()
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "kimi-code/k3", planMode: false })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Hello",
      attachments: [],
      model: "kimi-code/k3",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    // Make abort fail so we can verify local finish still happens.
    api.abortPrompt = async (sessionId: string, promptId: string) => {
      api.calls.push({ method: "abortPrompt", args: [sessionId, promptId] })
      throw new Error("network error")
    }

    await turn.interrupt()

    const stream = await collectStream(turn.stream)
    expect(stream.some((event) => event.type === "transcript" && event.entry?.kind === "interrupted")).toBe(true)
    expect(api.calls.some((call) => call.method === "abortPrompt")).toBe(true)
  })

  test("approvals are answered via the onApprovalRequest callback", async () => {
    const { manager, api, events } = managerWithFakes()
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "kimi-code/k3", planMode: false })

    const approvalResponse: HarnessApprovalResponse = { decision: "approved", scope: "session" }
    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Do something sensitive",
      attachments: [],
      model: "kimi-code/k3",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async (request) => {
        expect(request.options.map((o) => o.id)).toContain("approve_session")
        return approvalResponse
      },
    })

    events.emit("session_1", {
      type: "event.approval.requested",
      data: { approval_id: "a1", tool: "Bash", action: "run_command", input: { command: "rm -rf /" } },
    })
    events.emit("session_1", { type: "turn.ended", data: { reason: "completed" } })

    await collectStream(turn.stream)

    const resolveCall = api.calls.find((call) => call.method === "resolveApproval")
    expect(resolveCall?.args[2]).toMatchObject({ decision: "approved", scope: "session" })
  })

  test("questions are answered via the onToolRequest callback", async () => {
    const { manager, api, events } = managerWithFakes()
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "kimi-code/k3", planMode: false })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Choose",
      attachments: [],
      model: "kimi-code/k3",
      planMode: false,
      onToolRequest: async (request) => {
        expect(request.tool.toolKind).toBe("ask_user_question")
        return { q1: { kind: "single", option_id: "opt_1" } }
      },
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    events.emit("session_1", {
      type: "event.question.requested",
      data: { question_id: "q1", questions: [{ id: "q1", question: "Pick one", options: [{ label: "A", id: "opt_1" }] }] },
    })
    events.emit("session_1", { type: "turn.ended", data: { reason: "completed" } })

    await collectStream(turn.stream)

    const answerCall = api.calls.find((call) => call.method === "answerQuestion")
    expect(answerCall?.args[2]).toEqual({ answers: { q1: { kind: "single", option_id: "opt_1" } } })
  })
})

describe("normalizeKimiToolCall", () => {
  test("maps known Kimi tools to normalized tool kinds", () => {
    const entry = normalizeKimiToolCall("Bash", "t1", { command: "pwd" })
    expect(entry.kind).toBe("tool_call")
    if (entry.kind !== "tool_call") return
    expect(entry.tool.toolKind).toBe("bash")
    expect(entry.tool.input).toMatchObject({ command: "pwd" })
  })
})

describe("kimiSystemInitEntry", () => {
  test("produces a provider-tagged system_init entry", () => {
    const entry = kimiSystemInitEntry("kimi-code/k3")
    expect(entry.kind).toBe("system_init")
    if (entry.kind !== "system_init") return
    expect(entry.provider).toBe("kimi")
    expect(entry.model).toBe("kimi-code/k3")
    expect(entry.tools.length).toBeGreaterThan(0)
  })
})

describe("kimiTurnResult", () => {
  test("produces a success result by default", () => {
    const entry = kimiTurnResult()
    expect(entry.kind).toBe("result")
    if (entry.kind !== "result") return
    expect(entry.isError).toBe(false)
  })

  test("produces an error result when requested", () => {
    const entry = kimiTurnResult("failed", true)
    expect(entry.kind).toBe("result")
    if (entry.kind !== "result") return
    expect(entry.isError).toBe(true)
    expect(entry.subtype).toBe("error")
  })
})
