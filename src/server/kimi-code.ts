/**
 * Kimi Code local-server integration.
 *
 * Kanna talks to the current Kimi Code local server started by `kimi web --no-open`.
 * This manager multiplexes many Kanna chats onto Kimi sessions over one shared
 * server connection, normalizes Kimi's realtime events into Kanna's HarnessEvent
 * model, and handles reconnect/replay recovery.
 */

import type {
  ChatAttachment,
  HarnessSkill,
  TranscriptEntry,
} from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import { AsyncQueue } from "./async-queue"
import { timestamped } from "./transcript"
import {
  KimiCodeApi,
  type KimiApprovalRequest,
  type KimiApprovalResponse,
  type KimiPromptSubmission,
  type KimiQuestionRequest,
  type KimiSession,
  isKimiSessionNotFound,
} from "./kimi-code-api"
import {
  KimiCodeServerProcess,
  type KimiServerConnection,
  redactKimiServerSecret,
} from "./kimi-code-server"
import {
  KimiEventConnection,
  applyKimiDelta,
  createKimiTextAccumulator,
  type KimiTextAccumulator,
  type KimiWsEvent,
} from "./kimi-code-events"
import { applyKimiModels } from "./provider-catalog"

export interface HarnessApprovalRequest {
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

export interface HarnessApprovalResponse {
  decision: "approved" | "rejected" | "cancelled"
  scope?: "session"
  feedback?: string
  selected_label?: string
}

export interface StartKimiSessionArgs {
  chatId: string
  cwd: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken?: string | null
  pendingForkSessionToken?: string | null
}

export interface StartKimiTurnArgs {
  chatId: string
  content: string
  attachments: ChatAttachment[]
  model: string
  effort?: string
  planMode: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onApprovalRequest: (request: HarnessApprovalRequest) => Promise<HarnessApprovalResponse>
}

export interface SteerKimiTurnArgs {
  chatId: string
  content: string
  attachments: ChatAttachment[]
  model: string
  effort?: string
  planMode: boolean
}

export interface KimiCodeManagerArgs {
  server?: KimiCodeServerProcess
  api?: KimiCodeApi
  events?: KimiEventConnection
}

interface KimiPendingInteraction {
  id: string
  kind: "approval" | "question"
}

interface KimiToolAccumulator {
  input: Record<string, unknown>
  callAppended: boolean
}

interface KimiPendingTurn {
  promptId: string
  mainTurnId?: string | number
  queue: AsyncQueue<HarnessEvent>
  text: KimiTextAccumulator
  tools: Map<string, KimiToolAccumulator>
  pendingInteractions: Map<string, KimiPendingInteraction>
  resolved: boolean
  cancelRequested: boolean
  recovering: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onApprovalRequest: (request: HarnessApprovalRequest) => Promise<HarnessApprovalResponse>
}

interface KimiChatContext {
  chatId: string
  sessionId: string
  cwd: string
  subscription: { close(): void }
  pendingTurn: KimiPendingTurn | null
  closed: boolean
}

function randomPromptId(): string {
  return `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function redactKimiError(error: unknown, token: string): Error {
  if (error instanceof Error) {
    const redacted = new Error(redactKimiServerSecret(error.message, token))
    redacted.stack = redactKimiServerSecret(error.stack ?? "", token)
    return redacted
  }
  return new Error(redactKimiServerSecret(String(error), token))
}

export function normalizeKimiToolCall(toolName: string, toolId: string, input: unknown): TranscriptEntry {
  const record = asRecord(input as unknown) ?? {}
  const tool = normalizeToolCall({
    toolName,
    toolId,
    input: record,
  })
  return timestamped({ kind: "tool_call", tool })
}

export function kimiSystemInitEntry(model: string): TranscriptEntry {
  return timestamped({
    kind: "system_init",
    provider: "kimi",
    model,
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "AskUserQuestion", "ExitPlanMode"],
    agents: [],
    slashCommands: [],
    mcpServers: [],
  })
}

export function kimiTurnResult(reason?: string, isError = false): TranscriptEntry {
  return timestamped({
    kind: "result",
    subtype: isError ? "error" : "success",
    isError,
    durationMs: 0,
    result: reason ?? "",
  })
}

function toKimiContentParts(content: string, _attachments: ChatAttachment[]): KimiPromptSubmission["content"] {
  // Task 11 will add native attachment parts. For now, attachments are surfaced
  // through the existing <kanna-attachments> prompt hint built by AgentCoordinator.
  return [{ type: "text", text: content }]
}

function normalizeKimiQuestionRequest(request: KimiQuestionRequest): HarnessToolRequest {
  const rawQuestions = Array.isArray(request.questions) ? request.questions : []
  const questions = rawQuestions.map((q): { id?: string; question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean } => {
    const record = asRecord(q) ?? {}
    const options = Array.isArray(record.options)
      ? record.options.map((o) => {
          const or = asRecord(o) ?? {}
          return { label: asString(or.label) ?? "", description: asString(or.description) ?? undefined }
        }).filter((o) => o.label)
      : undefined
    return {
      id: asString(record.id),
      question: asString(record.question) ?? "",
      header: asString(record.header) ?? undefined,
      ...(options && options.length > 0 ? { options } : {}),
      multiSelect: record.multiSelect === true,
    }
  })

  return {
    tool: {
      kind: "tool",
      toolKind: "ask_user_question",
      toolName: "AskUserQuestion",
      toolId: request.id,
      input: { questions },
      rawInput: request as unknown as Record<string, unknown>,
    },
  }
}

function normalizeKimiApprovalRequest(request: KimiApprovalRequest): HarnessApprovalRequest {
  const toolName = asString(request.tool) ?? "unknown"
  const action = asString(request.action) ?? ""
  const input = asRecord(request.input) ?? {}
  const options: HarnessApprovalRequest["options"] = [
    { id: "approve", label: "Approve" },
    { id: "approve_session", label: "Approve for session" },
    { id: "reject", label: "Reject" },
    { id: "cancel", label: "Cancel" },
  ]

  const inputRecord = asRecord(input) ?? {}
  const planExit = action === "exit_plan_mode" || toolName === "ExitPlanMode"
    ? {
        plan: asString(inputRecord.plan) ?? undefined,
        options: Array.isArray(inputRecord.options)
          ? (inputRecord.options as unknown[]).map((o) => {
              const or = asRecord(o) ?? {}
              return { label: asString(or.label) ?? "", description: asString(or.description) ?? undefined }
            })
          : undefined,
      }
    : undefined

  return {
    id: request.id,
    toolId: request.id,
    toolName,
    action,
    input,
    options,
    ...(planExit ? { planExit } : {}),
  }
}

function mapKimiApprovalResponse(kanna: HarnessApprovalResponse): KimiApprovalResponse {
  switch (kanna.decision) {
    case "approved":
      return {
        decision: "approved",
        ...(kanna.scope === "session" ? { scope: "session" as const } : {}),
        ...(typeof kanna.selected_label === "string" ? { selected_label: kanna.selected_label } : {}),
        ...(typeof kanna.feedback === "string" ? { feedback: kanna.feedback } : {}),
      }
    case "rejected":
      return {
        decision: "rejected",
        ...(typeof kanna.feedback === "string" ? { feedback: kanna.feedback } : {}),
      }
    case "cancelled":
    default:
      return { decision: "cancelled" }
  }
}

export class KimiCodeManager {
  private readonly server: KimiCodeServerProcess
  private api: KimiCodeApi | null = null
  private events: KimiEventConnection | null = null
  private connection: KimiServerConnection | null = null
  private readonly chats = new Map<string, KimiChatContext>()
  private ensureReadyPromise: Promise<void> | null = null

  constructor(args: KimiCodeManagerArgs = {}) {
    this.server = args.server ?? new KimiCodeServerProcess()
    if (args.api) this.api = args.api
    if (args.events) this.events = args.events
  }

  private token(): string {
    return this.connection?.token ?? ""
  }

  private redactError(error: unknown): Error {
    return redactKimiError(error, this.token())
  }

  async ensureReady(): Promise<void> {
    if (this.connection) return
    if (this.ensureReadyPromise) return this.ensureReadyPromise

    this.ensureReadyPromise = this.doEnsureReady()
    return this.ensureReadyPromise
  }

  private async doEnsureReady(): Promise<void> {
    try {
      this.connection = await this.server.ensureReady()
      this.api = this.api ?? new KimiCodeApi({
        baseUrl: this.connection.baseUrl,
        token: this.connection.token,
      })
      this.events = this.events ?? new KimiEventConnection({
        baseUrl: this.connection.baseUrl,
        token: this.connection.token,
        onError: (message) => {
          // Surface as diagnostic only; reconnect is handled internally.
          console.error(`[kimi-events] ${redactKimiServerSecret(message, this.token())}`)
        },
      })
      await this.events.start()
      await this.refreshModelCatalog()
    } catch (error) {
      this.ensureReadyPromise = null
      throw this.redactError(error)
    }
  }

  async refreshModelCatalog(): Promise<boolean> {
    await this.ensureReady()
    try {
      const models = await this.api!.listModels()
      return applyKimiModels(models.map((model) => ({
        provider: model.provider ?? "kimi-code",
        model: model.model,
        displayName: model.display_name,
        maxContextSize: model.max_context_size,
        capabilities: model.capabilities,
        supportEfforts: model.support_efforts,
        defaultEffort: model.default_effort,
      })))
    } catch (error) {
      const message = this.redactError(error).message
      console.error(`[kimi-models] failed to refresh model catalog: ${message}`)
      return false
    }
  }

  async checkSession(sessionId: string): Promise<"available" | "missing"> {
    await this.ensureReady()
    try {
      await this.api!.getSession(sessionId)
      return "available"
    } catch (error) {
      if (isKimiSessionNotFound(error)) return "missing"
      return "available"
    }
  }

  async startSession(args: StartKimiSessionArgs): Promise<{ sessionToken: string; resumeFellBack: boolean }> {
    await this.ensureReady()

    const existing = this.chats.get(args.chatId)
    if (existing && existing.sessionId && !existing.closed) {
      return { sessionToken: existing.sessionId, resumeFellBack: false }
    }

    let session: KimiSession
    let resumeFellBack = false

    if (args.pendingForkSessionToken) {
      session = await this.api!.forkSession(args.pendingForkSessionToken)
    } else if (args.sessionToken) {
      try {
        session = await this.api!.getSession(args.sessionToken)
      } catch (error) {
        if (isKimiSessionNotFound(error)) {
          session = await this.createKimiSession(args)
          resumeFellBack = true
        } else {
          throw error
        }
      }
    } else {
      session = await this.createKimiSession(args)
    }

    const sessionId = session.id
    const subscription = this.events!.subscribe(sessionId, {
      onEvent: (event) => this.handleEvent(args.chatId, sessionId, event),
      onResyncRequired: () => this.handleResyncRequired(args.chatId, sessionId),
    })

    this.chats.set(args.chatId, {
      chatId: args.chatId,
      sessionId,
      cwd: args.cwd,
      subscription,
      pendingTurn: null,
      closed: false,
    })

    return { sessionToken: sessionId, resumeFellBack }
  }

  private async createKimiSession(args: StartKimiSessionArgs): Promise<KimiSession> {
    return await this.api!.createSession({
      metadata: { cwd: args.cwd },
      model: args.model,
      thinking: args.effort,
      permission_mode: "yolo",
      plan_mode: args.planMode,
    })
  }

  async startTurn(args: StartKimiTurnArgs): Promise<HarnessTurn> {
    await this.ensureReady()
    const context = this.requireChat(args.chatId)

    if (context.pendingTurn) {
      throw new Error("Kimi turn is already running")
    }

    const promptId = randomPromptId()
    const queue = new AsyncQueue<HarnessEvent>()

    queue.push({ type: "session_token", sessionToken: context.sessionId })
    queue.push({ type: "transcript", entry: kimiSystemInitEntry(args.model) })

    const pendingTurn: KimiPendingTurn = {
      promptId,
      queue,
      text: createKimiTextAccumulator(),
      tools: new Map(),
      pendingInteractions: new Map(),
      resolved: false,
      cancelRequested: false,
      recovering: false,
      onToolRequest: args.onToolRequest,
      onApprovalRequest: args.onApprovalRequest,
    }
    context.pendingTurn = pendingTurn

    try {
      const prompt = await this.api!.submitPrompt(context.sessionId, {
        content: toKimiContentParts(args.content, args.attachments),
        model: args.model,
        thinking: args.effort,
        permission_mode: "yolo",
        plan_mode: args.planMode,
        prompt_id: promptId,
      })
      pendingTurn.promptId = prompt.id
    } catch (error) {
      context.pendingTurn = null
      queue.finish()
      throw this.redactError(error)
    }

    return this.buildHarnessTurn(context, pendingTurn)
  }

  async steer(args: SteerKimiTurnArgs): Promise<"steered" | "started_new_turn"> {
    await this.ensureReady()
    const context = this.requireChat(args.chatId)
    const pendingTurn = context.pendingTurn

    if (!pendingTurn || pendingTurn.resolved) {
      return "started_new_turn"
    }

    try {
      const prompt = await this.api!.submitPrompt(context.sessionId, {
        content: toKimiContentParts(args.content, args.attachments),
        model: args.model,
        thinking: args.effort,
        permission_mode: "yolo",
        plan_mode: args.planMode,
        prompt_id: randomPromptId(),
      })

      if (prompt.status === "running") {
        // Previous prompt completed between the click and the request.
        pendingTurn.resolved = true
        context.pendingTurn = null
        return "started_new_turn"
      }

      if (prompt.status === "queued") {
        await this.api!.steerPrompt(context.sessionId, prompt.id)
      }

      return "steered"
    } catch (error) {
      throw this.redactError(error)
    }
  }

  async listSkills(_args: { chatId?: string; cwd: string }): Promise<HarnessSkill[] | null> {
    // Task 11 will wire live Kimi skill enumeration. Until then the composer sees
    // no Kimi skills rather than crashing on an unhandled provider.
    return null
  }

  closeChat(chatId: string): void {
    const context = this.chats.get(chatId)
    if (!context) return
    context.closed = true
    if (context.pendingTurn && !context.pendingTurn.resolved) {
      context.pendingTurn.resolved = true
      context.pendingTurn.queue.finish()
    }
    context.subscription.close()
    this.chats.delete(chatId)
  }

  stopAll(): void {
    for (const chatId of this.chats.keys()) {
      this.closeChat(chatId)
    }
    this.events?.close()
    this.events = null
    this.server.stop()
    this.connection = null
    this.ensureReadyPromise = null
  }

  private requireChat(chatId: string): KimiChatContext {
    const context = this.chats.get(chatId)
    if (!context || context.closed) {
      throw new Error(`Kimi session not started for chat ${chatId}`)
    }
    return context
  }

  private buildHarnessTurn(context: KimiChatContext, pendingTurn: KimiPendingTurn): HarnessTurn {
    return {
      provider: "kimi",
      stream: pendingTurn.queue,
      getAccountInfo: async () => {
        try {
          const auth = await this.api!.getAuth()
          return {
            email: auth.account?.email,
            organization: auth.account?.organization,
          }
        } catch {
          return null
        }
      },
      interrupt: async () => {
        if (pendingTurn.resolved) return
        pendingTurn.cancelRequested = true
        try {
          await this.api!.abortPrompt(context.sessionId, pendingTurn.promptId)
        } catch {
          try {
            await this.api!.abortSession(context.sessionId)
          } catch {
            // Best-effort abort.
          }
        }
        pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "interrupted" }) })
        pendingTurn.resolved = true
        pendingTurn.queue.finish()
        context.pendingTurn = null
      },
      close: () => {
        if (pendingTurn.resolved) return
        pendingTurn.resolved = true
        pendingTurn.queue.finish()
        context.pendingTurn = null
      },
      steer: async (steerArgs) => {
        return await this.steer({
          chatId: context.chatId,
          content: steerArgs.content,
          attachments: steerArgs.attachments,
          model: steerArgs.model ?? context.pendingTurn?.promptId ?? "",
          effort: steerArgs.effort,
          planMode: steerArgs.planMode ?? false,
        })
      },
    }
  }

  private handleEvent(chatId: string, _sessionId: string, event: KimiWsEvent): void {
    const context = this.chats.get(chatId)
    if (!context || context.closed) return

    const pendingTurn = context.pendingTurn
    if (!pendingTurn || pendingTurn.resolved) {
      // Events outside a tracked turn are ignored; they are likely background
      // subagent/task activity that must not affect the main chat transcript.
      return
    }

    const type = asString(event.type) ?? ""
    const data = asRecord(event.data) ?? {}
    const eventTurnId = asString(data.turn_id) ?? asString(data.prompt_id) ?? asString(data.promptId)

    // Bind the main turn identity on turn.started.
    if (type === "turn.started") {
      if (eventTurnId && pendingTurn.mainTurnId === undefined) {
        pendingTurn.mainTurnId = eventTurnId
      }
      return
    }

    // Ignore events attributed to a different turn (background/subagent).
    if (eventTurnId && pendingTurn.mainTurnId !== undefined && eventTurnId !== pendingTurn.mainTurnId) {
      return
    }

    if (type === "assistant.delta") {
      this.applyTextDelta(context, pendingTurn, "assistant", event)
      return
    }

    if (type === "thinking.delta") {
      this.applyTextDelta(context, pendingTurn, "thinking", event)
      return
    }

    if (type === "tool.call.started") {
      const toolId = asString(data.tool_id) ?? asString(data.id) ?? randomPromptId()
      const toolName = asString(data.tool) ?? asString(data.tool_name) ?? "unknown"
      const input = asRecord(data.input) ?? {}
      let accumulator = pendingTurn.tools.get(toolId)
      if (!accumulator) {
        accumulator = { input, callAppended: false }
        pendingTurn.tools.set(toolId, accumulator)
      }
      if (!accumulator.callAppended) {
        accumulator.callAppended = true
        pendingTurn.queue.push({ type: "transcript", entry: normalizeKimiToolCall(toolName, toolId, input) })
      }
      return
    }

    if (type === "tool.call.delta") {
      const toolId = asString(data.tool_id) ?? asString(data.id) ?? ""
      const accumulator = pendingTurn.tools.get(toolId)
      if (accumulator) {
        const delta = asRecord(data.delta) ?? {}
        accumulator.input = { ...accumulator.input, ...delta }
      }
      return
    }

    if (type === "tool.progress") {
      // Surface as a status entry without duplicating the tool call.
      const status = asString(data.status) ?? asString(data.message) ?? "working"
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({ kind: "status", status }),
      })
      return
    }

    if (type === "tool.result") {
      const toolId = asString(data.tool_id) ?? asString(data.id) ?? ""
      const content = data.output ?? data.result ?? data.content ?? ""
      const isError = data.status === "failed" || data.status === "error"
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({ kind: "tool_result", toolId, content, isError: Boolean(isError) }),
      })
      return
    }

    if (type === "event.approval.requested") {
      const requestId = asString(data.approval_id) ?? asString(data.id) ?? ""
      if (pendingTurn.pendingInteractions.has(requestId)) return
      const request: KimiApprovalRequest = {
        id: requestId,
        tool: asString(data.tool) ?? "unknown",
        action: asString(data.action) ?? "",
        input: data.input ?? {},
      }
      const normalized = normalizeKimiApprovalRequest(request)
      pendingTurn.pendingInteractions.set(requestId, { id: requestId, kind: "approval" })
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_call",
          tool: {
            kind: "tool",
            toolKind: "unknown_tool",
            toolName: normalized.toolName,
            toolId: requestId,
            input: { payload: normalized.input },
            rawInput: request as unknown as Record<string, unknown>,
          },
        }),
      })
      void this.handleApprovalRequest(context, pendingTurn, requestId, normalized)
      return
    }

    if (type === "event.approval.resolved") {
      const approvalId = asString(data.approval_id) ?? asString(data.id) ?? ""
      pendingTurn.pendingInteractions.delete(approvalId)
      return
    }

    if (type === "event.question.requested") {
      const requestId = asString(data.question_id) ?? asString(data.id) ?? ""
      if (pendingTurn.pendingInteractions.has(requestId)) return
      const request: KimiQuestionRequest = {
        id: requestId,
        questions: Array.isArray(data.questions) ? data.questions : [],
      }
      const toolRequest = normalizeKimiQuestionRequest(request)
      pendingTurn.pendingInteractions.set(requestId, { id: requestId, kind: "question" })
      pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "tool_call", tool: toolRequest.tool }) })
      void this.handleQuestionRequest(context, pendingTurn, requestId, toolRequest)
      return
    }

    if (type === "event.question.answered" || type === "event.question.dismissed") {
      const questionId = asString(data.question_id) ?? asString(data.id) ?? ""
      pendingTurn.pendingInteractions.delete(questionId)
      return
    }

    if (type.startsWith("compaction.")) {
      const summary = asString(data.summary)
      if (summary) {
        pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "compact_summary", summary }) })
      } else {
        pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "compact_boundary" }) })
      }
      return
    }

    if (type === "turn.ended") {
      this.finishTurn(context, pendingTurn, data)
      return
    }

    if (type === "prompt.aborted") {
      if (!pendingTurn.resolved) {
        pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "interrupted" }) })
        pendingTurn.resolved = true
        pendingTurn.queue.finish()
        context.pendingTurn = null
      }
      return
    }

    if (type === "error") {
      const errorMessage = asString(data.message) ?? asString(data.error) ?? "Kimi runtime error"
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "status",
          status: errorMessage,
        }),
      })
      return
    }

    if (type === "status") {
      const status = asString(data.status) ?? asString(data.message) ?? ""
      if (status) {
        pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "status", status }) })
      }
      return
    }
  }

  private async handleQuestionRequest(
    context: KimiChatContext,
    pendingTurn: KimiPendingTurn,
    requestId: string,
    toolRequest: HarnessToolRequest,
  ): Promise<void> {
    if (pendingTurn.resolved) return
    try {
      const result = await pendingTurn.onToolRequest(toolRequest)
      pendingTurn.pendingInteractions.delete(requestId)
      await this.api!.answerQuestion(context.sessionId, requestId, { answers: result })
    } catch (error) {
      pendingTurn.pendingInteractions.delete(requestId)
      console.error(`[kimi-question] failed to answer question: ${this.redactError(error).message}`)
    }
  }

  private async handleApprovalRequest(
    context: KimiChatContext,
    pendingTurn: KimiPendingTurn,
    requestId: string,
    request: HarnessApprovalRequest,
  ): Promise<void> {
    if (pendingTurn.resolved) return
    try {
      const result = await pendingTurn.onApprovalRequest(request)
      pendingTurn.pendingInteractions.delete(requestId)
      await this.api!.resolveApproval(context.sessionId, requestId, mapKimiApprovalResponse(result))
    } catch (error) {
      pendingTurn.pendingInteractions.delete(requestId)
      console.error(`[kimi-approval] failed to resolve approval: ${this.redactError(error).message}`)
    }
  }

  private applyTextDelta(
    context: KimiChatContext,
    pendingTurn: KimiPendingTurn,
    channel: "assistant" | "thinking",
    event: KimiWsEvent,
  ): void {
    const result = applyKimiDelta(pendingTurn.text, channel, event)
    pendingTurn.text = result.accumulator
    if (result.gapDetected && !pendingTurn.recovering) {
      pendingTurn.recovering = true
      void this.recoverFromSnapshot({ chatId: context.chatId, sessionId: context.sessionId, pendingTurn })
      return
    }
    if (result.duplicate) return

    const text = channel === "assistant" ? pendingTurn.text.assistant : pendingTurn.text.thinking
    const offset = channel === "assistant" ? pendingTurn.text.assistantOffset : pendingTurn.text.thinkingOffset
    pendingTurn.queue.push({
      type: "live_text_delta",
      delta: { channel: channel === "thinking" ? "reasoning" : "assistant", text, offset },
    })
  }

  private finishTurn(context: KimiChatContext, pendingTurn: KimiPendingTurn, data: Record<string, unknown>): void {
    if (pendingTurn.resolved) return

    const reason = asString(data.reason) ?? ""
    const isError = data.status === "failed" || data.status === "error" || reason === "error"
    const isCancelled = data.status === "cancelled" || reason === "cancelled" || reason === "aborted"

    // Flush final assistant text once.
    if (pendingTurn.text.assistant.length > 0) {
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({ kind: "assistant_text", text: pendingTurn.text.assistant }),
      })
    }

    if (isCancelled) {
      pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "interrupted" }) })
    } else {
      pendingTurn.queue.push({ type: "transcript", entry: kimiTurnResult(reason, isError) })
    }

    pendingTurn.resolved = true
    pendingTurn.queue.finish()
    context.pendingTurn = null
  }

  private handleResyncRequired(chatId: string, sessionId: string): void {
    const context = this.chats.get(chatId)
    if (!context || context.closed || !context.pendingTurn || context.pendingTurn.resolved) return
    context.pendingTurn.recovering = true
    void this.recoverFromSnapshot({ chatId, sessionId, pendingTurn: context.pendingTurn })
  }

  private async recoverFromSnapshot(ctx: { chatId: string; sessionId: string; pendingTurn: KimiPendingTurn }): Promise<void> {
    try {
      const snapshot = await this.api!.getSnapshot(ctx.sessionId)
      await this.resolveSnapshot(ctx.pendingTurn, snapshot)
    } catch (error) {
      console.error(`[kimi-resync] snapshot recovery failed: ${this.redactError(error).message}`)
    } finally {
      ctx.pendingTurn.recovering = false
    }
  }

  private async resolveSnapshot(pendingTurn: KimiPendingTurn, snapshot: import("./kimi-code-api").KimiSnapshot): Promise<void> {
    // Snapshot-driven recovery: rebuild text/interactions from the server truth.
    // The snapshot format is experimental; this is the minimal safe hook.
    const contextRecord = asRecord(snapshot.context)
    if (contextRecord) {
      const assistant = asString(contextRecord.assistant_text) ?? asString(contextRecord.assistantText)
      if (assistant && assistant.length > pendingTurn.text.assistant.length) {
        pendingTurn.text.assistant = assistant
        pendingTurn.text.assistantOffset = assistant.length
        pendingTurn.queue.push({
          type: "live_text_delta",
          delta: { channel: "assistant", text: assistant, offset: assistant.length },
        })
      }
      const thinking = asString(contextRecord.thinking_text) ?? asString(contextRecord.thinkingText)
      if (thinking && thinking.length > pendingTurn.text.thinking.length) {
        pendingTurn.text.thinking = thinking
        pendingTurn.text.thinkingOffset = thinking.length
        pendingTurn.queue.push({
          type: "live_text_delta",
          delta: { channel: "reasoning", text: thinking, offset: thinking.length },
        })
      }
    }
  }
}

// Re-export types used by AgentCoordinator.
export type { KimiServerConnection } from "./kimi-code-server"
