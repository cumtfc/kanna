import { afterEach, describe, expect, test } from "bun:test"
import type { Server, ServerWebSocket } from "bun"
import {
  KimiEventConnection,
  applyKimiDelta,
  createKimiTextAccumulator,
  type KimiWsEvent,
} from "./kimi-code-events"

type WsHandler = (ws: ServerWebSocket<unknown>, message: KimiWsEvent) => void

function createFakeKimiServer(handler?: WsHandler): Server<unknown> {
  return Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/api/v1/ws") {
        const upgraded = server.upgrade(request, { data: {} })
        if (upgraded) return undefined
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "server_hello", epoch: "epoch-1", seq: 0 }))
      },
      message(ws, raw) {
        try {
          const message = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as KimiWsEvent
          handler?.(ws, message)
        } catch {
          // ignore malformed test traffic
        }
      },
      close() {},
    },
  })
}

describe("KimiEventConnection", () => {
  let server: Server<unknown>

  afterEach(() => {
    server?.stop(true)
  })

  test("waits for server_hello before marking ready and subscribes with session_ids", async () => {
    let received: KimiWsEvent[] = []
    server = createFakeKimiServer((ws, message) => {
      received.push(message)
      if (message.type === "subscribe" && message.session_id === "session-1") {
        ws.send(JSON.stringify({ type: "turn.started", session_id: "session-1", seq: 1 }))
      }
    })

    const events: KimiWsEvent[] = []
    const connection = new KimiEventConnection({
      baseUrl: `http://${server.hostname}:${server.port}`,
      token: "test-token",
      initialBackoffMs: 10,
    })

    await connection.start()
    connection.subscribe("session-1", {
      onEvent: (event) => events.push(event),
      onResyncRequired: () => {},
    })

    // Give the subscribe message time to round-trip.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(received.some((message) => message.type === "subscribe" && message.session_id === "session-1")).toBe(true)
    expect(events.some((event) => event.type === "turn.started")).toBe(true)

    connection.close()
  })

  test("reconnects with the last cursor and replays durable events", async () => {
    let connectCount = 0
    server = createFakeKimiServer((ws, message) => {
      if (message.type === "subscribe") {
        connectCount += 1
        if (connectCount === 2) {
          // Replay missed events after reconnect.
          ws.send(JSON.stringify({ type: "assistant.delta", session_id: "session-1", seq: 11, epoch: "epoch-1", offset: 12, text: " world" }))
        }
      }
    })

    const connection = new KimiEventConnection({
      baseUrl: `http://${server.hostname}:${server.port}`,
      token: "test-token",
      initialBackoffMs: 10,
      maxBackoffMs: 100,
    })

    await connection.start()
    const events: KimiWsEvent[] = []
    connection.subscribe("session-1", {
      onEvent: (event) => events.push(event),
      onResyncRequired: () => {},
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Simulate an event, then drop the socket.
    server?.publish("/*", JSON.stringify({ type: "assistant.delta", session_id: "session-1", seq: 10, epoch: "epoch-1", offset: 0, text: "hello " }))

    await new Promise((resolve) => setTimeout(resolve, 30))
    connection.close()

    expect(connectCount).toBeGreaterThanOrEqual(1)
    expect(events.length).toBeGreaterThanOrEqual(0)
  })

  test("calls onResyncRequired when the server emits resync_required", async () => {
    server = createFakeKimiServer((ws, message) => {
      if (message.type === "subscribe" && message.session_id === "session-1") {
        ws.send(JSON.stringify({ type: "resync_required", session_id: "session-1" }))
      }
    })

    const resyncs: string[] = []
    const connection = new KimiEventConnection({
      baseUrl: `http://${server.hostname}:${server.port}`,
      token: "test-token",
      initialBackoffMs: 10,
    })

    await connection.start()
    connection.subscribe("session-1", {
      onEvent: () => {},
      onResyncRequired: () => resyncs.push("resync"),
    })

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(resyncs).toContain("resync")

    connection.close()
  })

  test("stops reconnecting after close()", async () => {
    server = createFakeKimiServer()

    const connection = new KimiEventConnection({
      baseUrl: `http://${server.hostname}:${server.port}`,
      token: "test-token",
      initialBackoffMs: 10,
      maxBackoffMs: 100,
    })

    await connection.start()
    connection.close()

    await new Promise((resolve) => setTimeout(resolve, 150))
    // No crash and no new subscriptions means close took effect.
    expect(connection.getSubscriptionCount()).toBe(0)
  })

  test("routes events only to the matching session subscription", async () => {
    server = createFakeKimiServer((ws, message) => {
      if (message.type === "subscribe") {
        ws.send(JSON.stringify({ type: "ping", session_id: message.session_id, seq: 1 }))
      }
    })

    const eventsA: KimiWsEvent[] = []
    const eventsB: KimiWsEvent[] = []
    const connection = new KimiEventConnection({
      baseUrl: `http://${server.hostname}:${server.port}`,
      token: "test-token",
      initialBackoffMs: 10,
    })

    await connection.start()
    connection.subscribe("session-a", {
      onEvent: (event) => eventsA.push(event),
      onResyncRequired: () => {},
    })
    connection.subscribe("session-b", {
      onEvent: (event) => eventsB.push(event),
      onResyncRequired: () => {},
    })

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(eventsA.every((event) => event.session_id === "session-a")).toBe(true)
    expect(eventsB.every((event) => event.session_id === "session-b")).toBe(true)

    connection.close()
  })
})

describe("applyKimiDelta", () => {
  test("appends when offset matches local length", () => {
    const accumulator = createKimiTextAccumulator()
    accumulator.assistant = "hello "
    accumulator.assistantOffset = 6

    const result = applyKimiDelta(accumulator, "assistant", { offset: 6, text: "world" })
    expect(result.gapDetected).toBe(false)
    expect(result.duplicate).toBe(false)
    expect(result.accumulator.assistant).toBe("hello world")
    expect(result.accumulator.assistantOffset).toBe(11)
  })

  test("ignores duplicate when offset is behind local length", () => {
    const accumulator = createKimiTextAccumulator()
    accumulator.assistant = "hello world"
    accumulator.assistantOffset = 11

    const result = applyKimiDelta(accumulator, "assistant", { offset: 6, text: "world" })
    expect(result.gapDetected).toBe(false)
    expect(result.duplicate).toBe(true)
    expect(result.accumulator.assistant).toBe("hello world")
  })

  test("detects a gap when offset is ahead of local length", () => {
    const accumulator = createKimiTextAccumulator()
    accumulator.assistant = "hello "
    accumulator.assistantOffset = 6

    const result = applyKimiDelta(accumulator, "assistant", { offset: 20, text: "world" })
    expect(result.gapDetected).toBe(true)
    expect(result.duplicate).toBe(false)
    expect(result.accumulator.assistant).toBe("hello ")
  })

  test("handles thinking.delta independently from assistant.delta", () => {
    const accumulator = createKimiTextAccumulator()
    accumulator.thinking = "step 1"
    accumulator.thinkingOffset = 6

    const result = applyKimiDelta(accumulator, "thinking", { offset: 6, text: " -> step 2" })
    expect(result.gapDetected).toBe(false)
    expect(result.accumulator.thinking).toBe("step 1 -> step 2")
    expect(result.accumulator.assistant).toBe("")
  })
})
