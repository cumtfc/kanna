import { afterEach, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { KimiApiError, KimiCodeApi, KIMI_SESSION_NOT_FOUND_CODE, isKimiSessionNotFound } from "./kimi-code-api"

type MockHandler = (request: Request) => Response | undefined

function createMockServer(handler: MockHandler): Server<unknown> {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const response = handler(request)
      if (response) return response
      return new Response(JSON.stringify({ code: 404, msg: "not found", data: null }), { status: 404 })
    },
  })
}

function envelope<T>(data: T, code = 0, msg = "success"): Response {
  return new Response(JSON.stringify({ code, msg, data, request_id: `req_${Math.random().toString(36).slice(2)}` }), {
    headers: { "Content-Type": "application/json" },
  })
}

describe("KimiCodeApi", () => {
  let server: Server<unknown>

  afterEach(() => {
    server?.stop(true)
  })

  test("returns envelope data for a successful request", async () => {
    server = createMockServer((request) => {
      if (request.url.endsWith("/api/v1/models")) {
        expect(request.headers.get("Authorization")).toBe("Bearer test-token")
        return envelope([
          {
            model: "kimi-code/k3",
            display_name: "K3",
            max_context_size: 1_048_576,
            support_efforts: ["max"],
            default_effort: "max",
          },
        ])
      }
      return undefined
    })

    const api = new KimiCodeApi({ baseUrl: `http://${server.hostname}:${server.port}`, token: "test-token" })
    const models = await api.listModels()
    expect(models).toHaveLength(1)
    expect(models[0]?.model).toBe("kimi-code/k3")
  })

  test("throws KimiApiError for non-zero business code on HTTP 200", async () => {
    server = createMockServer((request) => {
      if (request.url.endsWith("/api/v1/sessions/session-123")) {
        return new Response(
          JSON.stringify({ code: KIMI_SESSION_NOT_FOUND_CODE, msg: "session not found", data: null }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      return undefined
    })

    const api = new KimiCodeApi({ baseUrl: `http://${server.hostname}:${server.port}`, token: "test-token" })
    try {
      await api.getSession("session-123")
      expect.unreachable("expected KimiApiError")
    } catch (error) {
      expect(error).toBeInstanceOf(KimiApiError)
      const kimError = error as KimiApiError
      expect(kimError.code).toBe(KIMI_SESSION_NOT_FOUND_CODE)
      expect(kimError.message).toContain("session not found")
    }
  })

  test("throws KimiApiError for HTTP error responses", async () => {
    server = createMockServer((request) => {
      if (request.url.endsWith("/api/v1/auth")) {
        return new Response(JSON.stringify({ code: 401, msg: "unauthorized", data: null }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      }
      return undefined
    })

    const api = new KimiCodeApi({ baseUrl: `http://${server.hostname}:${server.port}`, token: "test-token" })
    await expect(api.getAuth()).rejects.toBeInstanceOf(KimiApiError)
  })

  test("isKimiSessionNotFound recognizes the business code and HTTP 404", async () => {
    server = createMockServer((request) => {
      if (request.url.endsWith("/api/v1/sessions/business-404")) {
        return new Response(
          JSON.stringify({ code: KIMI_SESSION_NOT_FOUND_CODE, msg: "session not found", data: null }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      if (request.url.endsWith("/api/v1/sessions/http-404")) {
        return new Response(JSON.stringify({ code: 404, msg: "not found", data: null }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (request.url.endsWith("/api/v1/sessions/other-error")) {
        return new Response(JSON.stringify({ code: 500, msg: "server error", data: null }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      }
      return undefined
    })

    const api = new KimiCodeApi({ baseUrl: `http://${server.hostname}:${server.port}`, token: "test-token" })

    const business = await api.getSession("business-404").catch((error) => error)
    expect(isKimiSessionNotFound(business)).toBe(true)

    const http = await api.getSession("http-404").catch((error) => error)
    expect(isKimiSessionNotFound(http)).toBe(true)

    const other = await api.getSession("other-error").catch((error) => error)
    expect(isKimiSessionNotFound(other)).toBe(false)

    expect(isKimiSessionNotFound(new Error("random"))).toBe(false)
  })

  test("checkProtocolCompatibility reports missing required surface", async () => {
    server = createMockServer((request) => {
      if (request.url.endsWith("/openapi.json")) {
        return envelope({
          paths: {
            "/api/v1/sessions": { post: {} },
            "/api/v1/models": { get: {} },
          },
        })
      }
      if (request.url.endsWith("/asyncapi.json")) {
        return envelope({ channels: {} })
      }
      if (request.url.endsWith("/api/v1/meta")) {
        return envelope({ version: "0.1.0", protocolVersion: 1 })
      }
      return undefined
    })

    const api = new KimiCodeApi({ baseUrl: `http://${server.hostname}:${server.port}`, token: "test-token" })
    const result = await api.checkProtocolCompatibility()
    expect(result.ok).toBe(false)
    expect(result.missing.length).toBeGreaterThan(0)
    expect(result.missing).toContain("GET /api/v1/sessions/{session_id}")
    expect(result.missing).toContain("WS /api/v1/ws")
    expect(result.protocolVersion).toBe(1)
  })

  test("checkProtocolCompatibility succeeds when all required surface is present", async () => {
    server = createMockServer((request) => {
      if (request.url.endsWith("/openapi.json")) {
        return envelope({
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
        })
      }
      if (request.url.endsWith("/asyncapi.json")) {
        return envelope({ channels: { "/api/v1/ws": {} } })
      }
      if (request.url.endsWith("/api/v1/meta")) {
        return envelope({ version: "0.1.0", protocolVersion: 2 })
      }
      return undefined
    })

    const api = new KimiCodeApi({ baseUrl: `http://${server.hostname}:${server.port}`, token: "test-token" })
    const result = await api.checkProtocolCompatibility()
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.protocolVersion).toBe(2)
  })

  test("checkProtocolCompatibility reports missing openapi/asyncapi documents", async () => {
    server = createMockServer(() => {
      return new Response(JSON.stringify({ code: 404, msg: "not found", data: null }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    })

    const api = new KimiCodeApi({ baseUrl: `http://${server.hostname}:${server.port}`, token: "test-token" })
    const result = await api.checkProtocolCompatibility()
    expect(result.ok).toBe(false)
    expect(result.missing).toContain("GET /openapi.json")
  })
})
