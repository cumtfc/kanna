/**
 * Fake Kimi Code local server for end-to-end tests.
 *
 * Speaks the subset of Kimi REST + WebSocket that Kanna consumes. Tests can
 * drive the server through scenarios: queued prompt responses, emitted events,
 * cursor replays, resync_required, and snapshot recovery.
 */

import type { Server, ServerWebSocket } from "bun"
import type {
  KimiApprovalRequest,
  KimiApprovalResponse,
  KimiAuthSnapshot,
  KimiEnvelope,
  KimiMeta,
  KimiModelItem,
  KimiPromptItem,
  KimiPromptSubmission,
  KimiQuestionRequest,
  KimiSession,
  KimiSessionStatus,
  KimiSkillItem,
  KimiSnapshot,
} from "../kimi-code-api"
import type { KimiWsEvent } from "../kimi-code-events"

export interface FakeKimiPrompt {
  id: string
  sessionId: string
  status: "running" | "queued" | "completed" | "aborted"
  content?: KimiPromptSubmission["content"]
  model?: string
  thinking?: string
  permissionMode?: string
  planMode?: boolean
}

export interface FakeKimiSession {
  id: string
  metadata?: Record<string, unknown>
  model?: string
  thinking?: string
  permissionMode?: string
  planMode?: boolean
  prompts: FakeKimiPrompt[]
  approvals: KimiApprovalRequest[]
  questions: KimiQuestionRequest[]
  forkedFrom?: string
}

export interface FakeKimiEventEnvelope extends KimiWsEvent {
  session_id: string
  seq: number
}

export interface FakeKimiServerOptions {
  token?: string
  models?: KimiModelItem[]
  auth?: KimiAuthSnapshot
  /** If true, the next getSession for a stored missing id will return not-found once. */
  missingSessionId?: string | null
}

interface WsData {
  wsId: number
}

interface ClientSession {
  ws: ServerWebSocket<WsData>
  cursor: number
  epoch: string
  sessionId: string
}

function envelope<T>(data: T, code = 0, msg = "success", requestId?: string): KimiEnvelope<T> {
  return { code, msg, data, request_id: requestId ?? `req_${Math.random().toString(36).slice(2, 10)}` }
}

export class FakeKimiServer {
  private server: Server<unknown> | null = null
  private readonly token: string
  private readonly models: KimiModelItem[]
  private readonly auth: KimiAuthSnapshot
  private sessions = new Map<string, FakeKimiSession>()
  private clients = new Map<string, ClientSession>()
  private nextSessionId = 1
  private nextPromptId = 1
  private nextSeq = 1
  private nextWsId = 1
  private epoch: string
  private missingSessionId: string | null
  private pendingEvents: FakeKimiEventEnvelope[] = []

  constructor(options: FakeKimiServerOptions = {}) {
    this.token = options.token ?? "fake-kimi-token"
    this.models = options.models ?? [
      {
        model: "kimi-code/k3",
        display_name: "K3",
        max_context_size: 1_048_576,
        support_efforts: ["max"],
        default_effort: "max",
      },
    ]
    this.auth = options.auth ?? { signed_in: true, account: { email: "test@example.com" } }
    this.epoch = `epoch-${Date.now()}`
    this.missingSessionId = options.missingSessionId ?? null
  }

  async start(): Promise<void> {
    if (this.server) return

    this.server = Bun.serve({
      port: 0,
      fetch: async (request, server) => await this.handleHttp(request, server),
      websocket: {
        open: (ws: ServerWebSocket<WsData>) => this.handleWsOpen(ws),
        message: (ws: ServerWebSocket<WsData>, raw: string | Buffer) => this.handleWsMessage(ws, raw),
        close: (ws: ServerWebSocket<WsData>) => this.handleWsClose(ws),
      },
    })
  }

  stop(closeActiveConnections = true): void {
    this.server?.stop(closeActiveConnections)
    this.server = null
    this.clients.clear()
    this.pendingEvents = []
  }

  get baseUrl(): string {
    if (!this.server) throw new Error("FakeKimiServer not started")
    return `http://${this.server.hostname}:${this.server.port}`
  }

  get connection() {
    return { baseUrl: this.baseUrl, token: this.token, owned: true }
  }

  seedSession(sessionId: string, body?: Partial<Omit<FakeKimiSession, "id" | "prompts">>): void {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      Object.assign(existing, body)
      return
    }
    this.sessions.set(sessionId, {
      id: sessionId,
      prompts: [],
      approvals: [],
      questions: [],
      ...body,
    })
  }

  setMissingSessionId(sessionId: string | null): void {
    this.missingSessionId = sessionId
  }

  createPrompt(sessionId: string, body: KimiPromptSubmission): FakeKimiPrompt {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)

    const prompt: FakeKimiPrompt = {
      id: `prompt_${this.nextPromptId++}`,
      sessionId,
      status: "running",
      content: body.content,
      model: body.model,
      thinking: body.thinking,
      permissionMode: body.permission_mode,
      planMode: body.plan_mode,
    }
    session.prompts.push(prompt)
    return prompt
  }

  completePrompt(promptId: string): void {
    const prompt = this.findPrompt(promptId)
    if (prompt) prompt.status = "completed"
  }

  abortPrompt(promptId: string): void {
    const prompt = this.findPrompt(promptId)
    if (prompt) prompt.status = "aborted"
  }

  private findPrompt(promptId: string): FakeKimiPrompt | undefined {
    for (const session of Array.from(this.sessions.values())) {
      for (const prompt of session.prompts) {
        if (prompt.id === promptId) return prompt
      }
    }
    return undefined
  }

  emitEvent(sessionId: string, event: KimiWsEvent): void {
    const full: FakeKimiEventEnvelope = {
      ...event,
      session_id: sessionId,
      seq: this.nextSeq++,
      epoch: this.epoch,
    }
    this.pendingEvents.push(full)

    for (const client of Array.from(this.clients.values())) {
      if (client.sessionId === sessionId && client.cursor < full.seq) {
        client.ws.send(JSON.stringify(full))
        client.cursor = full.seq
      }
    }
  }

  emitResyncRequired(sessionId: string): void {
    for (const client of Array.from(this.clients.values())) {
      if (client.sessionId === sessionId) {
        client.ws.send(JSON.stringify({ type: "resync_required", session_id: sessionId }))
      }
    }
  }

  /** Force-close every WebSocket subscribed to a session to simulate a network drop. */
  disconnectSession(sessionId: string): void {
    const toClose = new Set<ServerWebSocket<WsData>>()
    for (const client of Array.from(this.clients.values())) {
      if (client.sessionId === sessionId) {
        toClose.add(client.ws)
      }
    }
    for (const ws of toClose) {
      ws.close()
    }
  }

  /** Simulate a server-side snapshot for session recovery tests. */
  setSnapshot(sessionId: string, snapshot: KimiSnapshot): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)
    ;(session as unknown as Record<string, unknown>).snapshot = snapshot
  }

  getSessionById(sessionId: string): FakeKimiSession | undefined {
    return this.sessions.get(sessionId)
  }

  getCalls(): unknown[] {
    // Intentionally simple; tests inspect API effects through state/events.
    return []
  }

  private async handleHttp(request: Request, server: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === "/api/v1/ws") {
      const upgraded = server.upgrade(request, { data: { wsId: this.nextWsId++ } })
      if (upgraded) return undefined
      return new Response("upgrade failed", { status: 400 })
    }

    if (request.headers.get("Authorization") !== `Bearer ${this.token}`) {
      return this.jsonEnvelope(null, 401, "unauthorized", 401)
    }

    try {
      if (path === "/api/v1/meta" && request.method === "GET") {
        return this.jsonEnvelope<KimiMeta>({ version: "0.1.0-test", protocolVersion: 1 })
      }

      if (path === "/openapi.json" && request.method === "GET") {
        return this.jsonEnvelope(this.openapi())
      }

      if (path === "/asyncapi.json" && request.method === "GET") {
        return this.jsonEnvelope({ channels: { "/api/v1/ws": {} } })
      }

      if (path === "/api/v1/auth" && request.method === "GET") {
        return this.jsonEnvelope<KimiAuthSnapshot>(this.auth)
      }

      if (path === "/api/v1/models" && request.method === "GET") {
        return this.jsonEnvelope<KimiModelItem[]>(this.models)
      }

      const sessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)$/)
      if (sessionMatch && request.method === "GET") {
        const sessionId = decodeURIComponent(sessionMatch[1]!)
        if (this.missingSessionId === sessionId) {
          this.missingSessionId = null
          return this.jsonEnvelope(null, 4_040_404, "session not found", 404)
        }
        const session = this.sessions.get(sessionId)
        if (!session) {
          return this.jsonEnvelope(null, 4_040_404, "session not found", 404)
        }
        return this.jsonEnvelope<KimiSession>({
          id: session.id,
          metadata: session.metadata,
        })
      }

      if (path === "/api/v1/sessions" && request.method === "POST") {
        return this.handleCreateSession(request)
      }

      const forkMatch = path.match(/^\/api\/v1\/sessions\/([^/]+):fork$/)
      if (forkMatch && request.method === "POST") {
        return this.handleForkSession(decodeURIComponent(forkMatch[1]!))
      }

      const abortSessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+):abort$/)
      if (abortSessionMatch && request.method === "POST") {
        return this.jsonEnvelope<{ aborted: boolean }>({ aborted: true })
      }

      const statusMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/status$/)
      if (statusMatch && request.method === "GET") {
        const sessionId = decodeURIComponent(statusMatch[1]!)
        const session = this.sessions.get(sessionId)
        if (!session) return this.jsonEnvelope(null, 4_040_404, "session not found", 404)
        return this.jsonEnvelope<KimiSessionStatus>({
          id: session.id,
          status: "ready",
          context_tokens: 42,
          max_context_tokens: session.model ? 1_048_576 : undefined,
        })
      }

      const skillsMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/skills$/)
      if (skillsMatch && request.method === "GET") {
        return this.jsonEnvelope<KimiSkillItem[]>([
          { name: "test:hello", description: "Say hello", source: "builtin" },
        ])
      }

      const promptsMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/prompts$/)
      if (promptsMatch && request.method === "POST") {
        return this.handleSubmitPrompt(decodeURIComponent(promptsMatch[1]!), request)
      }

      const steerMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/prompts\/([^/]+):steer$/)
      if (steerMatch && request.method === "POST") {
        return this.jsonEnvelope<void>(undefined as unknown as void)
      }

      const abortPromptMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/prompts\/([^/]+):abort$/)
      if (abortPromptMatch && request.method === "POST") {
        const promptId = decodeURIComponent(abortPromptMatch[2]!)
        this.abortPrompt(promptId)
        return this.jsonEnvelope<void>(undefined as unknown as void)
      }

      const approvalsMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/approvals$/)
      if (approvalsMatch && request.method === "GET") {
        const sessionId = decodeURIComponent(approvalsMatch[1]!)
        const session = this.sessions.get(sessionId)
        return this.jsonEnvelope<KimiApprovalRequest[]>(session?.approvals ?? [])
      }

      const approvalResolveMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/approvals\/([^/]+)$/)
      if (approvalResolveMatch && request.method === "POST") {
        return this.handleResolveApproval(decodeURIComponent(approvalResolveMatch[1]!), decodeURIComponent(approvalResolveMatch[2]!), request)
      }

      const questionsMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/questions$/)
      if (questionsMatch && request.method === "GET") {
        const sessionId = decodeURIComponent(questionsMatch[1]!)
        const session = this.sessions.get(sessionId)
        return this.jsonEnvelope<KimiQuestionRequest[]>(session?.questions ?? [])
      }

      const answerQuestionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/questions\/([^/]+)$/)
      if (answerQuestionMatch && request.method === "POST") {
        return this.jsonEnvelope<void>(undefined as unknown as void)
      }

      const snapshotMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/snapshot$/)
      if (snapshotMatch && request.method === "GET") {
        return this.handleGetSnapshot(decodeURIComponent(snapshotMatch[1]!))
      }

      return this.jsonEnvelope(null, 404, "not found", 404)
    } catch (error) {
      return this.jsonEnvelope(null, 500, String(error), 500)
    }
  }

  private async handleCreateSession(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<{
      metadata: Record<string, unknown>
      model: string
      thinking: string
      permission_mode: string
      plan_mode: boolean
    }>
    const id = `session_${this.nextSessionId++}`
    const session: FakeKimiSession = {
      id,
      metadata: body.metadata,
      model: body.model,
      thinking: body.thinking,
      permissionMode: body.permission_mode,
      planMode: body.plan_mode,
      prompts: [],
      approvals: [],
      questions: [],
    }
    this.sessions.set(id, session)
    return this.jsonEnvelope<KimiSession>({ id, metadata: body.metadata })
  }

  private handleForkSession(sourceId: string): Response {
    const source = this.sessions.get(sourceId)
    if (!source) return this.jsonEnvelope(null, 4_040_404, "session not found", 404)
    const id = `session_${this.nextSessionId++}`
    const forked: FakeKimiSession = {
      ...source,
      id,
      forkedFrom: sourceId,
      prompts: [...source.prompts],
      approvals: [...source.approvals],
      questions: [...source.questions],
    }
    this.sessions.set(id, forked)
    return this.jsonEnvelope<KimiSession>({ id, metadata: { forkedFrom: sourceId } })
  }

  private async handleSubmitPrompt(sessionId: string, request: Request): Promise<Response> {
    const session = this.sessions.get(sessionId)
    if (!session) return this.jsonEnvelope(null, 4_040_404, "session not found", 404)
    const body = (await request.json()) as KimiPromptSubmission

    // If the session already has an active running prompt, queue the new one
    // so that native steer scenarios can exercise the queued -> steer path.
    const hasRunning = session.prompts.some((p) => p.status === "running")
    const prompt = this.createPrompt(sessionId, body)
    if (hasRunning) {
      prompt.status = "queued"
    }

    return this.jsonEnvelope<KimiPromptItem>({
      id: prompt.id,
      status: prompt.status,
      content: body.content,
    })
  }

  private async handleResolveApproval(sessionId: string, approvalId: string, request: Request): Promise<Response> {
    const session = this.sessions.get(sessionId)
    if (!session) return this.jsonEnvelope(null, 4_040_404, "session not found", 404)
    const body = (await request.json()) as KimiApprovalResponse
    session.approvals = session.approvals.filter((a) => a.id !== approvalId)
    this.emitEvent(sessionId, {
      type: "event.approval.resolved",
      data: { approval_id: approvalId, decision: body.decision },
    })
    return this.jsonEnvelope<void>(undefined as unknown as void)
  }

  private handleGetSnapshot(sessionId: string): Response {
    const session = this.sessions.get(sessionId)
    if (!session) return this.jsonEnvelope(null, 4_040_404, "session not found", 404)
    const snapshot = ((session as unknown as Record<string, unknown>).snapshot ?? {
      session_id: sessionId,
      entries: [],
      context: {},
    }) as KimiSnapshot
    return this.jsonEnvelope<KimiSnapshot>(snapshot)
  }

  private handleWsOpen(ws: ServerWebSocket<WsData>): void {
    ws.send(JSON.stringify({ type: "server_hello", epoch: this.epoch, seq: 0 }))
  }

  private handleWsMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
    try {
      const message = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as KimiWsEvent
      if (message.type === "subscribe" && typeof message.session_id === "string") {
        const sessionId = message.session_id
        const requestedCursor =
          message.cursor && typeof (message.cursor as { seq?: number }).seq === "number"
            ? (message.cursor as { seq: number }).seq
            : 0
        const client: ClientSession = { ws, cursor: requestedCursor, epoch: this.epoch, sessionId }
        this.clients.set(this.clientKey(ws, sessionId), client)

        // Replay durable events past the client's cursor.
        for (const event of this.pendingEvents) {
          if (event.session_id === sessionId && event.seq > requestedCursor) {
            ws.send(JSON.stringify(event))
            client.cursor = event.seq
          }
        }
      }

      if (message.type === "unsubscribe" && typeof message.session_id === "string") {
        this.clients.delete(this.clientKey(ws, message.session_id))
      }
    } catch {
      // ignore malformed test traffic
    }
  }

  private handleWsClose(ws: ServerWebSocket<WsData>): void {
    const wsId = ws.data.wsId
    for (const key of Array.from(this.clients.keys())) {
      if (key.startsWith(`${wsId}:`)) {
        this.clients.delete(key)
      }
    }
  }

  private clientKey(ws: ServerWebSocket<WsData>, sessionId: string): string {
    return `${ws.data.wsId}:${sessionId}`
  }

  private jsonEnvelope<T>(data: T, code = 0, msg = "success", status = 200): Response {
    return new Response(JSON.stringify(envelope(data, code, msg)), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }

  private openapi(): Record<string, unknown> {
    return {
      paths: {
        "/api/v1/sessions": { post: {} },
        "/api/v1/sessions/{session_id}": { get: {} },
        "/api/v1/sessions/{session_id}:fork": { post: {} },
        "/api/v1/sessions/{session_id}:abort": { post: {} },
        "/api/v1/sessions/{session_id}/prompts": { post: {} },
        "/api/v1/sessions/{session_id}/prompts/{prompt_id}:steer": { post: {} },
        "/api/v1/sessions/{session_id}/prompts/{prompt_id}:abort": { post: {} },
        "/api/v1/sessions/{session_id}/snapshot": { get: {} },
        "/api/v1/sessions/{session_id}/approvals": { get: {} },
        "/api/v1/sessions/{session_id}/approvals/{approval_id}": { post: {} },
        "/api/v1/sessions/{session_id}/questions": { get: {} },
        "/api/v1/sessions/{session_id}/questions/{question_id}": { post: {} },
        "/api/v1/models": { get: {} },
      },
    }
  }
}
