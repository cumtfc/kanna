/**
 * Shared WebSocket event connection to the Kimi Code local server.
 *
 * One physical WebSocket multiplexes subscriptions for many sessions. It
 * reconnects automatically with durable replay cursors and surfaces volatile
 * text-delta gaps to the manager so Kanna can recover from snapshots.
 */

export interface KimiEventCursor {
  seq: number
  epoch?: string | number
}

export interface KimiWsEvent {
  type: string
  session_id?: string
  data?: unknown
  seq?: number
  epoch?: string | number
  offset?: number
  text?: string
  [key: string]: unknown
}

export interface KimiEventHandlers {
  onEvent(event: KimiWsEvent): void
  onResyncRequired(): void
}

export interface KimiSessionSubscription {
  close(): void
}

export interface KimiEventConnectionArgs {
  baseUrl: string
  token: string
  WebSocket?: typeof WebSocket
  maxBackoffMs?: number
  initialBackoffMs?: number
  onError?: (message: string) => void
}

interface SubscriptionRecord {
  sessionId: string
  handlers: KimiEventHandlers
  cursor?: KimiEventCursor
}

interface PendingHello {
  resolve: () => void
  reject: (error: Error) => void
}

export class KimiEventConnection {
  private readonly baseUrl: string
  private readonly token: string
  private readonly WebSocketImpl: typeof WebSocket
  private readonly maxBackoffMs: number
  private readonly initialBackoffMs: number
  private readonly onError?: (message: string) => void

  private socket: WebSocket | null = null
  private started = false
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs: number
  private hello: PendingHello | null = null
  private subscriptions = new Map<string, SubscriptionRecord>()
  private lastEpoch?: string | number

  constructor(args: KimiEventConnectionArgs) {
    this.baseUrl = args.baseUrl.replace(/\/$/, "")
    this.token = args.token
    this.WebSocketImpl = args.WebSocket ?? WebSocket
    this.maxBackoffMs = args.maxBackoffMs ?? 30_000
    this.initialBackoffMs = args.initialBackoffMs ?? 500
    this.backoffMs = this.initialBackoffMs
    this.onError = args.onError
  }

  private wsUrl(): string {
    const httpUrl = new URL(this.baseUrl)
    const protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:"
    return `${protocol}//${httpUrl.host}/api/v1/ws`
  }

  private resetBackoff() {
    this.backoffMs = this.initialBackoffMs
  }

  private scheduleBackoff(): number {
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs)
    return delay
  }

  private authSubprotocol(): string {
    return `kimi-code.bearer.${this.token}`
  }

  private openSocket() {
    const url = this.wsUrl()

    let socket: WebSocket
    try {
      // Bun supports an options bag with headers; standard WHATWG WebSocket does not.
      const AnyWebSocket = this.WebSocketImpl as unknown as {
        new (
          url: string,
          protocols?: string | string[],
          options?: { headers?: Record<string, string> }
        ): WebSocket
      }
      socket = new AnyWebSocket(url, [], { headers: { Authorization: `Bearer ${this.token}` } })
    } catch {
      // Fall back to the documented subprotocol bearer form.
      socket = new this.WebSocketImpl(url, this.authSubprotocol())
    }

    socket.onopen = () => {
      this.resetBackoff()
    }

    socket.onmessage = (event) => {
      let message: KimiWsEvent
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : "") as KimiWsEvent
      } catch {
        this.onError?.("Received malformed WebSocket message from Kimi server")
        return
      }

      if (message.type === "server_hello") {
        this.hello?.resolve()
        this.hello = null
        this.sendSubscriptions()
        return
      }

      if (message.type === "resync_required") {
        this.broadcastResyncRequired()
        return
      }

      const sessionId = message.session_id
      if (typeof sessionId === "string") {
        const subscription = this.subscriptions.get(sessionId)
        if (subscription) {
          if (typeof message.seq === "number") {
            subscription.cursor = { seq: message.seq, epoch: message.epoch ?? subscription.cursor?.epoch }
            this.lastEpoch = message.epoch ?? this.lastEpoch
          }
          subscription.handlers.onEvent(message)
        }
        return
      }

      // Global event without session attribution: record but do not route.
      if (typeof message.seq === "number") {
        this.lastEpoch = message.epoch ?? this.lastEpoch
      }
    }

    socket.onclose = () => {
      this.socket = null
      if (this.hello) {
        this.hello.reject(new Error("WebSocket closed before server_hello"))
        this.hello = null
      }
      if (!this.closed) {
        const delay = this.scheduleBackoff()
        this.reconnectTimer = setTimeout(() => this.connect(), delay)
      }
    }

    socket.onerror = () => {
      // onclose will schedule reconnect; just surface a diagnostic here.
      this.onError?.("Kimi WebSocket error")
    }

    this.socket = socket
  }

  private async connect(): Promise<void> {
    if (this.closed || this.socket) return

    this.openSocket()

    return new Promise<void>((resolve, reject) => {
      this.hello = { resolve, reject }
    })
  }

  private send(message: unknown) {
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  private sendSubscriptions() {
    const sessionIds = [...this.subscriptions.keys()]
    if (sessionIds.length === 0) return

    for (const sessionId of sessionIds) {
      const subscription = this.subscriptions.get(sessionId)
      const cursor = subscription?.cursor ?? { seq: 0, epoch: this.lastEpoch }
      this.send({
        type: "subscribe",
        session_id: sessionId,
        cursor,
      })
    }
  }

  private broadcastResyncRequired() {
    for (const subscription of this.subscriptions.values()) {
      subscription.handlers.onResyncRequired()
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.connect()
  }

  subscribe(sessionId: string, handlers: KimiEventHandlers): KimiSessionSubscription {
    const existing = this.subscriptions.get(sessionId)
    if (existing) {
      existing.handlers = handlers
    } else {
      this.subscriptions.set(sessionId, { sessionId, handlers })
    }

    this.sendSubscriptions()

    return {
      close: () => {
        if (!this.subscriptions.has(sessionId)) return
        this.send({ type: "unsubscribe", session_id: sessionId })
        this.subscriptions.delete(sessionId)
      },
    }
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
    this.hello?.reject(new Error("Connection closed"))
    this.hello = null
  }

  /** Exposed for tests. */
  getSubscriptionCount(): number {
    return this.subscriptions.size
  }
}

/**
 * Turn-local accumulator for volatile Kimi text deltas.
 *
 * Kimi sends cumulative offsets; we verify them before appending so a gap can
 * trigger snapshot recovery rather than corrupting the transcript.
 */
export interface KimiTextAccumulator {
  assistant: string
  thinking: string
  assistantOffset: number
  thinkingOffset: number
}

export function createKimiTextAccumulator(): KimiTextAccumulator {
  return {
    assistant: "",
    thinking: "",
    assistantOffset: 0,
    thinkingOffset: 0,
  }
}

export interface ApplyDeltaResult {
  accumulator: KimiTextAccumulator
  gapDetected: boolean
  duplicate: boolean
}

export function applyKimiDelta(
  accumulator: KimiTextAccumulator,
  channel: "assistant" | "thinking",
  event: Pick<KimiWsEvent, "offset" | "text">
): ApplyDeltaResult {
  const offset = typeof event.offset === "number" ? event.offset : null
  const text = typeof event.text === "string" ? event.text : ""
  const localOffset = channel === "assistant" ? accumulator.assistantOffset : accumulator.thinkingOffset

  if (offset === null) {
    // No offset to validate against; append defensively.
    const next = channel === "assistant"
      ? { ...accumulator, assistant: accumulator.assistant + text, assistantOffset: accumulator.assistant.length + text.length }
      : { ...accumulator, thinking: accumulator.thinking + text, thinkingOffset: accumulator.thinking.length + text.length }
    return { accumulator: next, gapDetected: false, duplicate: false }
  }

  if (offset < localOffset) {
    return { accumulator, gapDetected: false, duplicate: true }
  }

  if (offset > localOffset) {
    return { accumulator, gapDetected: true, duplicate: false }
  }

  const next = channel === "assistant"
    ? { ...accumulator, assistant: accumulator.assistant + text, assistantOffset: offset + text.length }
    : { ...accumulator, thinking: accumulator.thinking + text, thinkingOffset: offset + text.length }
  return { accumulator: next, gapDetected: false, duplicate: false }
}
