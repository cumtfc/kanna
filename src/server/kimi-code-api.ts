/**
 * Minimal typed client for the Kimi Code local Server API. Only the subset
 * Kanna consumes is modeled here; the full experimental surface is intentionally
 * not copied from any SDK.
 */

export interface KimiEnvelope<T> {
  code: number
  msg: string
  data: T
  request_id?: string
}

export interface KimiMeta {
  version?: string
  protocolVersion?: number
}

export interface KimiAuthSnapshot {
  signed_in: boolean
  account?: {
    email?: string
    organization?: string
  }
}

export interface KimiSession {
  id: string
  created_at?: string
  updated_at?: string
  status?: string
  metadata?: Record<string, unknown>
}

export interface KimiSessionStatus {
  id: string
  status?: string
  context_tokens?: number
  max_context_tokens?: number
}

export interface KimiModelItem {
  model: string
  provider?: string
  display_name?: string
  max_context_size: number
  capabilities?: string[]
  support_efforts?: string[]
  default_effort?: string
}

export interface KimiPromptItem {
  id: string
  status?: string
  created_at?: string
  content?: unknown
}

export interface KimiApprovalRequest {
  id: string
  tool?: string
  action?: string
  input?: unknown
  created_at?: string
}

export interface KimiApprovalResponse {
  decision: "approved" | "rejected" | "cancelled"
  scope?: "session"
  feedback?: string
  selected_label?: string
}

export interface KimiQuestionRequest {
  id: string
  questions?: unknown[]
  created_at?: string
}

export interface KimiQuestionResponse {
  answers?: unknown
}

export interface KimiSnapshot {
  session_id?: string
  entries?: unknown[]
  context?: unknown
}

export interface KimiPromptSubmission {
  content: Array<{ type: "text"; text: string } | { type: string; [key: string]: unknown }>
  model?: string
  thinking?: string
  permission_mode?: "manual" | "yolo" | "auto"
  plan_mode?: boolean
  prompt_id?: string
}

export class KimiApiError extends Error {
  readonly code: number
  readonly requestId?: string
  readonly status?: number

  constructor(message: string, options: { code: number; requestId?: string; status?: number }) {
    super(message)
    this.name = "KimiApiError"
    this.code = options.code
    this.requestId = options.requestId
    this.status = options.status
  }
}

/** Kimi business code for a session that does not exist on the server. */
export const KIMI_SESSION_NOT_FOUND_CODE = 4_040_404

export function isKimiSessionNotFound(error: unknown): boolean {
  if (!(error instanceof KimiApiError)) return false
  if (error.status === 404) return true
  return error.code === KIMI_SESSION_NOT_FOUND_CODE
}

export interface KimiProtocolCompatibility {
  ok: boolean
  missing: string[]
  protocolVersion?: number
}

const REQUIRED_REST_PATHS: Array<{ method: string; path: string }> = [
  { method: "POST", path: "/api/v1/sessions" },
  { method: "GET", path: "/api/v1/sessions/{session_id}" },
  { method: "POST", path: "/api/v1/sessions/{session_id}:fork" },
  { method: "POST", path: "/api/v1/sessions/{session_id}:abort" },
  { method: "POST", path: "/api/v1/sessions/{session_id}/prompts" },
  { method: "POST", path: "/api/v1/sessions/{session_id}/prompts/{prompt_id}:steer" },
  { method: "POST", path: "/api/v1/sessions/{session_id}/prompts/{prompt_id}:abort" },
  { method: "GET", path: "/api/v1/sessions/{session_id}/snapshot" },
  { method: "GET", path: "/api/v1/sessions/{session_id}/approvals" },
  { method: "POST", path: "/api/v1/sessions/{session_id}/approvals/{approval_id}" },
  { method: "GET", path: "/api/v1/sessions/{session_id}/questions" },
  { method: "POST", path: "/api/v1/sessions/{session_id}/questions/{question_id}" },
  { method: "GET", path: "/api/v1/models" },
]

export interface KimiCodeApiArgs {
  baseUrl: string
  token: string
  fetch?: typeof globalThis.fetch
}

export class KimiCodeApi {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(args: KimiCodeApiArgs) {
    this.baseUrl = args.baseUrl.replace(/\/$/, "")
    this.token = args.token
    this.fetchFn = args.fetch ?? globalThis.fetch
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchFn(this.url(path), {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

    let envelope: KimiEnvelope<T> | undefined
    const text = await response.text()
    try {
      envelope = JSON.parse(text) as KimiEnvelope<T>
    } catch {
      // Not a JSON envelope — surface the HTTP status/text.
      throw new KimiApiError(
        response.ok ? `Invalid JSON response from Kimi server: ${text.slice(0, 200)}` : `Kimi server error: ${response.status} ${response.statusText}`,
        { code: response.status, status: response.status }
      )
    }

    if (!response.ok || envelope.code !== 0) {
      throw new KimiApiError(
        envelope.msg || `Kimi API error: ${response.status} ${response.statusText}`,
        { code: envelope.code, requestId: envelope.request_id, status: response.status }
      )
    }

    return envelope.data
  }

  async getMeta(): Promise<KimiMeta> {
    return await this.request<KimiMeta>("GET", "/api/v1/meta")
  }

  async getOpenApi(): Promise<unknown> {
    return await this.request<unknown>("GET", "/openapi.json")
  }

  async getAsyncApi(): Promise<unknown> {
    return await this.request<unknown>("GET", "/asyncapi.json")
  }

  async getAuth(): Promise<KimiAuthSnapshot> {
    return await this.request<KimiAuthSnapshot>("GET", "/api/v1/auth")
  }

  async listModels(): Promise<KimiModelItem[]> {
    return await this.request<KimiModelItem[]>("GET", "/api/v1/models")
  }

  async createSession(body?: { metadata?: Record<string, unknown>; model?: string; thinking?: string; permission_mode?: string; plan_mode?: boolean }): Promise<KimiSession> {
    return await this.request<KimiSession>("POST", "/api/v1/sessions", body)
  }

  async getSession(sessionId: string): Promise<KimiSession> {
    return await this.request<KimiSession>("GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}`)
  }

  async getSessionStatus(sessionId: string): Promise<KimiSessionStatus> {
    return await this.request<KimiSessionStatus>("GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}/status`)
  }

  async forkSession(sessionId: string): Promise<KimiSession> {
    return await this.request<KimiSession>("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}:fork`)
  }

  async abortSession(sessionId: string): Promise<{ aborted: boolean }> {
    return await this.request<{ aborted: boolean }>("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}:abort`)
  }

  async submitPrompt(sessionId: string, prompt: KimiPromptSubmission): Promise<KimiPromptItem> {
    return await this.request<KimiPromptItem>("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, prompt)
  }

  async steerPrompt(sessionId: string, promptId: string): Promise<void> {
    await this.request<void>("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:steer`)
  }

  async abortPrompt(sessionId: string, promptId: string): Promise<void> {
    await this.request<void>("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`)
  }

  async listPendingApprovals(sessionId: string): Promise<KimiApprovalRequest[]> {
    return await this.request<KimiApprovalRequest[]>("GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals`)
  }

  async resolveApproval(sessionId: string, approvalId: string, response: KimiApprovalResponse): Promise<void> {
    await this.request<void>("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, response)
  }

  async listPendingQuestions(sessionId: string): Promise<KimiQuestionRequest[]> {
    return await this.request<KimiQuestionRequest[]>("GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions`)
  }

  async answerQuestion(sessionId: string, questionId: string, response: KimiQuestionResponse): Promise<void> {
    await this.request<void>("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`, response)
  }

  async dismissQuestion(sessionId: string, questionId: string): Promise<void> {
    await this.request<void>("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}:dismiss`)
  }

  async getSnapshot(sessionId: string): Promise<KimiSnapshot> {
    return await this.request<KimiSnapshot>("GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`)
  }

  /**
   * Feature-detect the protocol surface Kanna actually needs. Parses the OpenAPI
   * document only enough to verify required paths/methods, and checks AsyncAPI
   * for the WebSocket endpoint.
   */
  async checkProtocolCompatibility(): Promise<KimiProtocolCompatibility> {
    const missing: string[] = []
    let protocolVersion: number | undefined

    try {
      const meta = await this.getMeta()
      protocolVersion = meta.protocolVersion ?? undefined
    } catch {
      // Meta is optional for the compatibility check; missing surface is what matters.
    }

    let openApi: unknown
    try {
      openApi = await this.getOpenApi()
    } catch {
      missing.push("GET /openapi.json")
      return { ok: false, missing, protocolVersion }
    }

    let asyncApi: unknown
    try {
      asyncApi = await this.getAsyncApi()
    } catch {
      missing.push("GET /asyncapi.json")
      return { ok: false, missing, protocolVersion }
    }

    for (const required of REQUIRED_REST_PATHS) {
      if (!openApiHasPath(openApi, required.method, required.path)) {
        missing.push(`${required.method} ${required.path}`)
      }
    }

    if (!asyncApiHasWs(asyncApi, "/api/v1/ws")) {
      missing.push("WS /api/v1/ws")
    }

    return { ok: missing.length === 0, missing, protocolVersion }
  }
}

function openApiHasPath(openApi: unknown, method: string, templatePath: string): boolean {
  const record = openApi && typeof openApi === "object" ? (openApi as Record<string, unknown>) : {}
  const paths = record.paths ?? record.Paths
  if (!paths || typeof paths !== "object") return false
  const pathEntry = (paths as Record<string, unknown>)[templatePath]
  if (!pathEntry || typeof pathEntry !== "object") return false
  const methodEntry = (pathEntry as Record<string, unknown>)[method.toLowerCase()]
  return methodEntry !== undefined
}

function asyncApiHasWs(asyncApi: unknown, channelName: string): boolean {
  const record = asyncApi && typeof asyncApi === "object" ? (asyncApi as Record<string, unknown>) : {}
  const channels = record.channels ?? record.Channels
  if (!channels || typeof channels !== "object") return false
  if ((channels as Record<string, unknown>)[channelName] !== undefined) return true
  // AsyncAPI 1.x uses `topics` or a single `topic` string.
  const topic = record.topic
  if (typeof topic === "string") return topic === channelName
  const topics = record.topics
  if (topics && typeof topics === "object") {
    return (topics as Record<string, unknown>)[channelName] !== undefined
  }
  return false
}
