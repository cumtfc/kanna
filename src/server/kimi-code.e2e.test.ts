import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { KimiCodeManager } from "./kimi-code"
import { KimiCodeServerProcess, type KimiServerConnection } from "./kimi-code-server"
import type { HarnessApprovalResponse, HarnessEvent, HarnessToolRequest } from "./harness-types"
import { FakeKimiServer } from "./test-utils/fake-kimi-server"

class ManagedFakeKimiServer extends KimiCodeServerProcess {
  private readonly fake: FakeKimiServer

  constructor(fake: FakeKimiServer) {
    super()
    this.fake = fake
  }

  override async ensureReady(): Promise<KimiServerConnection> {
    await this.fake.start()
    return this.fake.connection
  }

  override stop(): void {
    this.fake.stop(true)
  }
}

async function collectStream(stream: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const items: HarnessEvent[] = []
  for await (const item of stream) {
    items.push(item)
  }
  return items
}

describe("KimiCodeManager E2E against fake server", () => {
  let fake: FakeKimiServer
  let manager: KimiCodeManager

  beforeEach(async () => {
    fake = new FakeKimiServer()
    const server = new ManagedFakeKimiServer(fake)
    manager = new KimiCodeManager({ server })
  })

  afterEach(() => {
    manager.stopAll()
    fake.stop(true)
  })

  test("happy-path real-time chat creates a session, streams text, and finishes once", async () => {
    const { sessionToken } = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      effort: "max",
      planMode: false,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Hello",
      attachments: [],
      model: "kimi-code/k3",
      effort: "max",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    // Emit the fake Kimi runtime flow.
    fake.emitEvent(sessionToken, { type: "turn.started", data: { turn_id: "turn_1" } })
    fake.emitEvent(sessionToken, { type: "assistant.delta", data: {}, text: "Hello ", offset: 0 })
    fake.emitEvent(sessionToken, { type: "assistant.delta", data: {}, text: "world", offset: 6 })
    fake.emitEvent(sessionToken, { type: "tool.call.started", data: { tool_id: "t1", tool: "Bash", input: { command: "pwd" } } })
    fake.emitEvent(sessionToken, { type: "tool.result", data: { tool_id: "t1", output: "/tmp/project" } })
    fake.emitEvent(sessionToken, { type: "turn.ended", data: { reason: "completed" } })

    const events = await collectStream(turn.stream)

    // One session token persisted, live text visible, final transcript once.
    expect(events.some((e) => e.type === "session_token" && e.sessionToken === sessionToken)).toBe(true)
    expect(events.some((e) => e.type === "live_text_delta" && e.delta?.text === "Hello world")).toBe(true)

    const assistantTexts = events.filter((e) => e.type === "transcript" && e.entry?.kind === "assistant_text")
    expect(assistantTexts).toHaveLength(1)
    expect(assistantTexts[0]?.type === "transcript" && assistantTexts[0].entry?.kind === "assistant_text" && assistantTexts[0].entry.text).toBe("Hello world")

    const results = events.filter((e) => e.type === "transcript" && e.entry?.kind === "result")
    expect(results).toHaveLength(1)

    const toolCalls = events.filter((e) => e.type === "transcript" && e.entry?.kind === "tool_call")
    const toolResults = events.filter((e) => e.type === "transcript" && e.entry?.kind === "tool_result")
    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    expect(toolResults).toHaveLength(1)
  })

  test("question flow answers with exact option ids", async () => {
    const { sessionToken } = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
    })

    let capturedRequest: HarnessToolRequest | null = null

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Choose",
      attachments: [],
      model: "kimi-code/k3",
      planMode: false,
      onToolRequest: async (request) => {
        capturedRequest = request
        return { q1: { kind: "single", option_id: "opt_1" } }
      },
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    fake.emitEvent(sessionToken, {
      type: "event.question.requested",
      data: {
        question_id: "q1",
        questions: [{ id: "q1", question: "Pick one", options: [{ label: "A", id: "opt_1" }] }],
      },
    })

    // Give the async answer HTTP call time to complete before closing the turn.
    await new Promise((resolve) => setTimeout(resolve, 50))

    fake.emitEvent(sessionToken, { type: "turn.ended", data: { reason: "completed" } })

    await collectStream(turn.stream)

    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.tool.toolKind).toBe("ask_user_question")
  })

  test("approval flow resolves approve-once and approve-session decisions", async () => {
    const { sessionToken } = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
    })

    let callIndex = 0
    const responses: HarnessApprovalResponse[] = [
      { decision: "approved" },
      { decision: "approved", scope: "session" },
      { decision: "rejected", feedback: "no" },
    ]

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Do sensitive things",
      attachments: [],
      model: "kimi-code/k3",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => {
        return responses[callIndex++] ?? { decision: "cancelled" }
      },
    })

    fake.emitEvent(sessionToken, {
      type: "event.approval.requested",
      data: { approval_id: "a1", tool: "Bash", action: "run_command", input: { command: "rm -rf /" } },
    })

    // Give the async resolve HTTP call time to complete before closing the turn.
    await new Promise((resolve) => setTimeout(resolve, 50))

    fake.emitEvent(sessionToken, { type: "turn.ended", data: { reason: "completed" } })

    await collectStream(turn.stream)

    const session = fake.getSessionById(sessionToken)
    // The approval was removed after resolution.
    expect(session?.approvals).toHaveLength(0)
  })

  test("native steer promotes a queued prompt without aborting the active turn", async () => {
    const { sessionToken } = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "First message",
      attachments: [],
      model: "kimi-code/k3",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    // Native steer returns "steered" for an active turn.
    const steerResult = await turn.steer?.({
      content: "Steer message",
      attachments: [],
      model: "kimi-code/k3",
      effort: "max",
      planMode: false,
    })

    expect(steerResult).toBe("steered")

    fake.emitEvent(sessionToken, { type: "turn.started", data: { turn_id: "turn_1" } })
    fake.emitEvent(sessionToken, { type: "assistant.delta", data: {}, text: "Done", offset: 0 })
    fake.emitEvent(sessionToken, { type: "turn.ended", data: { reason: "completed" } })

    const events = await collectStream(turn.stream)
    expect(events.some((e) => e.type === "transcript" && e.entry?.kind === "interrupted")).toBe(false)
    expect(events.some((e) => e.type === "transcript" && e.entry?.kind === "assistant_text")).toBe(true)
  })

  test("reconnect replays durable events without duplication", async () => {
    const { sessionToken } = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Hello",
      attachments: [],
      model: "kimi-code/k3",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    fake.emitEvent(sessionToken, { type: "turn.started", data: { turn_id: "turn_1" } })
    fake.emitEvent(sessionToken, { type: "assistant.delta", data: {}, text: "hello ", offset: 0 })

    // Force a WebSocket reconnect without changing the server address.
    fake.disconnectSession(sessionToken)

    // Wait for the client to reconnect and resubscribe.
    await new Promise((resolve) => setTimeout(resolve, 150))

    fake.emitEvent(sessionToken, { type: "assistant.delta", data: {}, text: "world", offset: 6 })
    fake.emitEvent(sessionToken, { type: "turn.ended", data: { reason: "completed" } })

    const events = await collectStream(turn.stream)
    const deltas = events.filter((e) => e.type === "live_text_delta")
    const texts = deltas.map((d) => d.delta?.text)
    // The final cumulative text should appear exactly once as a delta.
    expect(texts.filter((t) => t === "hello world")).toHaveLength(1)

    const assistantTexts = events.filter((e) => e.type === "transcript" && e.entry?.kind === "assistant_text")
    expect(assistantTexts).toHaveLength(1)
  })

  test("resync_required recovers from snapshot and finishes", async () => {
    const { sessionToken } = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Hello",
      attachments: [],
      model: "kimi-code/k3",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    fake.emitEvent(sessionToken, { type: "turn.started", data: { turn_id: "turn_1" } })
    fake.emitEvent(sessionToken, { type: "assistant.delta", data: {}, text: "hello ", offset: 0 })
    fake.setSnapshot(sessionToken, {
      session_id: sessionToken,
      entries: [],
      context: { assistant_text: "hello recovered world" },
    })
    fake.emitResyncRequired(sessionToken)

    // Wait for the async snapshot recovery to finish before ending the turn.
    await new Promise((resolve) => setTimeout(resolve, 200))

    fake.emitEvent(sessionToken, { type: "turn.ended", data: { reason: "completed" } })

    const events = await collectStream(turn.stream)
    const finalTexts = events
      .filter((e) => e.type === "transcript" && e.entry?.kind === "assistant_text")
      .map((e) => (e.type === "transcript" && e.entry?.kind === "assistant_text" ? e.entry.text : ""))
    expect(finalTexts).toHaveLength(1)
    expect(finalTexts[0]).toBe("hello recovered world")
  })

  test("missing stored session falls back to a fresh session", async () => {
    fake.setMissingSessionId("session_missing")

    const result = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
      sessionToken: "session_missing",
    })

    expect(result.resumeFellBack).toBe(true)
    expect(result.sessionToken).not.toBe("session_missing")

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Hello again",
      attachments: [],
      model: "kimi-code/k3",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    fake.emitEvent(result.sessionToken, { type: "turn.started", data: { turn_id: "turn_1" } })
    fake.emitEvent(result.sessionToken, { type: "assistant.delta", data: {}, text: "Hi", offset: 0 })
    fake.emitEvent(result.sessionToken, { type: "turn.ended", data: { reason: "completed" } })

    const events = await collectStream(turn.stream)
    expect(events.some((e) => e.type === "session_token" && e.sessionToken === result.sessionToken)).toBe(true)
  })

  test("forking a chat creates a new Kimi session from the source", async () => {
    const first = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
    })

    const forked = await manager.startSession({
      chatId: "chat-fork",
      cwd: "/tmp/project",
      model: "kimi-code/k3",
      planMode: false,
      pendingForkSessionToken: first.sessionToken,
    })

    expect(forked.sessionToken).not.toBe(first.sessionToken)
    expect(forked.resumeFellBack).toBe(false)

    const forkedSession = fake.getSessionById(forked.sessionToken)
    expect(forkedSession?.forkedFrom).toBe(first.sessionToken)

    const turn = await manager.startTurn({
      chatId: "chat-fork",
      content: "Hello from fork",
      attachments: [],
      model: "kimi-code/k3",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    fake.emitEvent(forked.sessionToken, { type: "turn.started", data: { turn_id: "turn_fork" } })
    fake.emitEvent(forked.sessionToken, { type: "assistant.delta", data: {}, text: "Forked", offset: 0 })
    fake.emitEvent(forked.sessionToken, { type: "turn.ended", data: { reason: "completed" } })

    const events = await collectStream(turn.stream)
    expect(events.some((e) => e.type === "session_token" && e.sessionToken === forked.sessionToken)).toBe(true)
  })
})
