import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { KimiCodeServerProcess } from "./kimi-code-server"

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  signal: NodeJS.Signals | number | undefined

  kill(signal?: NodeJS.Signals | number) {
    this.killed = true
    this.signal = signal
    // Simulate the process exiting after being killed.
    this.emit("close", 0, null)
  }

  writeStdout(line: string) {
    this.stdout.write(`${line}\n`)
  }

  writeStderr(line: string) {
    this.stderr.write(`${line}\n`)
  }

  exit(code: number) {
    this.emit("close", code, null)
  }
}

function collectLogs() {
  const logs: string[] = []
  const warns: string[] = []
  const log = (message: string) => logs.push(message)
  const warn = (message: string) => warns.push(message)
  return { logs, warns, log, warn }
}

describe("KimiCodeServerProcess", () => {
  test("parses local URL and token and exposes a loopback connection", async () => {
    const { logs, warns, log, warn } = collectLogs()
    let spawned = false
    const child = new FakeChildProcess()

    const process = new KimiCodeServerProcess({
      env: {},
      log,
      warn,
      spawn: (command, args, options) => {
        spawned = true
        expect(command).toBe("kimi")
        expect(args).toEqual(["web", "--no-open"])
        expect(options.stdio).toEqual(["ignore", "pipe", "pipe"])
        return child as never
      },
    })

    const ready = process.ensureReady()
    child.writeStdout("Local: http://127.0.0.1:8080/?token=secret-token-123")
    child.writeStdout("Token: secret-token-123")
    child.writeStdout("ready")

    const connection = await ready
    expect(connection.baseUrl).toBe("http://127.0.0.1:8080")
    expect(connection.token).toBe("secret-token-123")
    expect(connection.owned).toBe(true)
    expect(spawned).toBe(true)

    // Token must never appear in captured logs/diagnostics.
    const allOutput = [...logs, ...warns].join("\n")
    expect(allOutput).not.toContain("secret-token-123")
    expect(allOutput).toContain("127.0.0.1:8080")

    process.stop()
    expect(child.killed).toBe(true)
  })

  test("keeps token in memory when it only appears on the URL query string", async () => {
    const { logs, warns, log, warn } = collectLogs()
    const child = new FakeChildProcess()

    const process = new KimiCodeServerProcess({
      env: {},
      log,
      warn,
      spawn: () => child as never,
    })

    const ready = process.ensureReady()
    child.writeStdout("Local: http://127.0.0.1:9090/?token=url-only-token")

    const connection = await ready
    expect(connection.baseUrl).toBe("http://127.0.0.1:9090")
    expect(connection.token).toBe("url-only-token")

    const allOutput = [...logs, ...warns].join("\n")
    expect(allOutput).not.toContain("url-only-token")
    expect(allOutput).not.toContain("?token=")

    process.stop()
  })

  test("rejects a startup URL whose hostname is not loopback in managed mode", async () => {
    const { warn, warns } = collectLogs()
    const child = new FakeChildProcess()

    const process = new KimiCodeServerProcess({
      env: {},
      warn,
      spawn: () => child as never,
    })

    const ready = process.ensureReady()
    child.writeStdout("Local: http://0.0.0.0:8080/?token=secret-token-123")

    try {
      await ready
      expect.unreachable("ensureReady should have rejected")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain("secret-token-123")
      expect(message).toContain("0.0.0.0")
    }

    const allOutput = warns.join("\n")
    expect(allOutput).not.toContain("secret-token-123")

    process.stop()
  })

  test("rejects when the child exits before announcing a local URL", async () => {
    const child = new FakeChildProcess()

    const process = new KimiCodeServerProcess({
      env: {},
      spawn: () => child as never,
    })

    const ready = process.ensureReady()
    child.writeStderr("kimi web is not installed")
    child.exit(1)

    await expect(ready).rejects.toThrow("Kimi Code server exited")

    process.stop()
  })

  test("kills the child when the manager is stopped", async () => {
    const child = new FakeChildProcess()

    const process = new KimiCodeServerProcess({
      env: {},
      spawn: () => child as never,
    })

    const ready = process.ensureReady()
    child.writeStdout("Local: http://127.0.0.1:8080/?token=tok")
    await ready

    process.stop()
    expect(child.killed).toBe(true)
  })

  test("external mode requires both URL and token and never spawns", async () => {
    const child = new FakeChildProcess()
    let spawned = false

    const withUrlOnly = new KimiCodeServerProcess({
      env: { KANNA_KIMI_SERVER_URL: "http://127.0.0.1:9000" },
      spawn: () => {
        spawned = true
        return child as never
      },
    })
    await expect(withUrlOnly.ensureReady()).rejects.toThrow(
      "KANNA_KIMI_SERVER_URL and KANNA_KIMI_SERVER_TOKEN must both be set",
    )
    expect(spawned).toBe(false)

    const withTokenOnly = new KimiCodeServerProcess({
      env: { KANNA_KIMI_SERVER_TOKEN: "external-token" },
      spawn: () => {
        spawned = true
        return child as never
      },
    })
    await expect(withTokenOnly.ensureReady()).rejects.toThrow(
      "KANNA_KIMI_SERVER_URL and KANNA_KIMI_SERVER_TOKEN must both be set",
    )
    expect(spawned).toBe(false)
  })

  test("external mode returns the configured connection without spawning", async () => {
    const child = new FakeChildProcess()
    let spawned = false

    const process = new KimiCodeServerProcess({
      env: {
        KANNA_KIMI_SERVER_URL: "http://127.0.0.1:9000",
        KANNA_KIMI_SERVER_TOKEN: "external-token",
      },
      spawn: () => {
        spawned = true
        return child as never
      },
    })

    const connection = await process.ensureReady()
    expect(connection.baseUrl).toBe("http://127.0.0.1:9000")
    expect(connection.token).toBe("external-token")
    expect(connection.owned).toBe(false)
    expect(spawned).toBe(false)

    process.stop()
    // External mode owns no process; stop is a no-op.
    expect(child.killed).toBe(false)
  })

  test("no token is included in thrown error messages or diagnostics", async () => {
    const { logs, warns, log, warn } = collectLogs()
    const child = new FakeChildProcess()

    const process = new KimiCodeServerProcess({
      env: {},
      log,
      warn,
      spawn: () => child as never,
    })

    const token = "leaked-bearer-token-xyz"
    const ready = process.ensureReady()
    child.writeStdout(`Local: http://127.0.0.1:8080/?token=${token}`)
    child.writeStderr(`failed to authenticate with token ${token}`)
    child.exit(1)

    try {
      await ready
      expect.unreachable("ensureReady should have rejected")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain(token)
    }

    const allOutput = [...logs, ...warns].join("\n")
    expect(allOutput).not.toContain(token)
  })
})
