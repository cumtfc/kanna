import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"

export interface KimiServerConnection {
  baseUrl: string
  token: string
  owned: boolean
}

interface ChildProcessLike {
  stdout?: Readable | null
  stderr?: Readable | null
  pid?: number
  killed?: boolean
  kill(signal?: NodeJS.Signals | number): void
  on(event: "error", listener: (error: Error) => void): this
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | number | null) => void): this
  once(event: "error", listener: (error: Error) => void): this
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | number | null) => void): this
}

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { stdio: ["ignore", "pipe", "pipe"]; env: NodeJS.ProcessEnv },
) => ChildProcessLike

type State =
  | { kind: "idle" }
  | {
      kind: "starting"
      resolve: (value: KimiServerConnection) => void
      reject: (error: Error) => void
    }
  | { kind: "ready"; connection: KimiServerConnection }
  | { kind: "failed"; error: Error }
  | { kind: "stopped" }

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
}

function baseUrlFromRawUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return rawUrl.split("?")[0] ?? rawUrl
  }
}

export function redactKimiServerSecret(message: string, token: string | null | undefined): string {
  if (!token || token.length === 0) return message
  return message.replaceAll(token, "[REDACTED]")
}

export interface KimiCodeServerProcessOptions {
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
  warn?: (message: string) => void
  spawn?: SpawnFn
}

export class KimiCodeServerProcess {
  private readonly env: NodeJS.ProcessEnv
  private readonly log: (message: string) => void
  private readonly warn: (message: string) => void
  private readonly spawn: SpawnFn
  private state: State = { kind: "idle" }
  private child: ChildProcessLike | null = null
  private tokenForRedaction: string | null = null
  private pendingBaseUrl: string | null = null
  private stderrLines: string[] = []

  constructor(options: KimiCodeServerProcessOptions = {}) {
    this.env = options.env ?? process.env
    this.log = options.log ?? console.log
    this.warn = options.warn ?? console.warn
    this.spawn =
      options.spawn ??
      ((command, args, spawnOptions) =>
        spawn(command, args as string[], spawnOptions as never) as unknown as ChildProcessLike)
  }

  ensureReady(): Promise<KimiServerConnection> {
    if (this.state.kind === "ready") {
      return Promise.resolve(this.state.connection)
    }
    if (this.state.kind === "failed") {
      return Promise.reject(this.redactError(this.state.error))
    }
    if (this.state.kind === "stopped") {
      return Promise.reject(new Error("Kimi Code server has been stopped"))
    }
    if (this.state.kind === "starting") {
      return new Promise<KimiServerConnection>((resolve, reject) => {
        const existing = this.state as Extract<State, { kind: "starting" }>
        const originalResolve = existing.resolve
        const originalReject = existing.reject
        existing.resolve = (value) => {
          originalResolve(value)
          resolve(value)
        }
        existing.reject = (error) => {
          originalReject(error)
          reject(error)
        }
      })
    }

    const externalUrl = this.env.KANNA_KIMI_SERVER_URL
    const externalToken = this.env.KANNA_KIMI_SERVER_TOKEN
    if (externalUrl || externalToken) {
      return this.connectExternal(externalUrl, externalToken)
    }

    return this.spawnManaged()
  }

  stop(): void {
    const previous = this.state
    this.state = { kind: "stopped" }
    if (this.child) {
      try {
        if (!this.child.killed) {
          this.child.kill("SIGTERM")
        }
      } catch (error) {
        this.warn(this.redact(`Failed to kill Kimi Code server: ${String(error)}`))
      }
      this.child = null
    }
    if (previous.kind === "starting") {
      previous.reject(new Error("Kimi Code server was stopped before it became ready"))
    }
  }

  private connectExternal(url: string | undefined, token: string | undefined): Promise<KimiServerConnection> {
    if (!url || !token) {
      const error = new Error(
        "KANNA_KIMI_SERVER_URL and KANNA_KIMI_SERVER_TOKEN must both be set to use an external Kimi Code server",
      )
      this.state = { kind: "failed", error }
      return Promise.reject(error)
    }

    try {
      const parsed = new URL(url)
      if (!isLoopback(parsed.hostname)) {
        const error = new Error(
          `External Kimi Code server URL must be loopback-only. Got: ${baseUrlFromRawUrl(url)}`,
        )
        this.state = { kind: "failed", error }
        return Promise.reject(error)
      }
      this.tokenForRedaction = token
      const connection: KimiServerConnection = {
        baseUrl: `${parsed.protocol}//${parsed.host}`,
        token,
        owned: false,
      }
      this.state = { kind: "ready", connection }
      return Promise.resolve(connection)
    } catch (error) {
      const wrapped = new Error(`Invalid KANNA_KIMI_SERVER_URL: ${baseUrlFromRawUrl(url)}`)
      this.state = { kind: "failed", error: wrapped }
      return Promise.reject(wrapped)
    }
  }

  private spawnManaged(): Promise<KimiServerConnection> {
    this.state = {
      kind: "starting",
      resolve: () => {},
      reject: () => {},
    }

    return new Promise<KimiServerConnection>((resolve, reject) => {
      const starting = this.state as Extract<State, { kind: "starting" }>
      starting.resolve = resolve
      starting.reject = reject

      try {
        // Managed mode always spawns with the loopback-only, authenticated form.
        // Never pass --host 0.0.0.0 or --dangerous-bypass-auth.
        const child = this.spawn("kimi", ["web", "--no-open"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: this.env,
        })
        this.child = child

        if (child.stdout) {
          const stdoutReader = createInterface({ input: child.stdout })
          stdoutReader.on("line", (line) => this.parseStartupLine(line))
        }
        if (child.stderr) {
          const stderrReader = createInterface({ input: child.stderr })
          stderrReader.on("line", (line) => {
            this.stderrLines.push(line)
            this.warn(this.redact(`[kimi stderr] ${line}`))
          })
        }

        child.once("error", (error) => {
          this.fail(error)
        })

        child.once("close", (code) => {
          if (this.state.kind === "starting") {
            const stderr = this.stderrLines.length > 0 ? this.stderrLines.join("\n") : "(no stderr)"
            this.fail(
              new Error(
                `Kimi Code server exited${code !== null ? ` with code ${code}` : ""} before becoming ready.\n${stderr}`,
              ),
            )
          } else if (this.state.kind === "ready") {
            this.state = { kind: "failed", error: new Error("Kimi Code server process exited unexpectedly") }
          }
          this.child = null
        })
      } catch (error) {
        this.fail(new Error(`Failed to start Kimi Code server: ${errorMessage(error)}`))
      }
    })
  }

  private parseStartupLine(line: string) {
    const localMatch = line.match(/^Local:\s*(\S+)/i)
    if (localMatch) {
      const rawUrl = localMatch[1]!
      try {
        const parsed = new URL(rawUrl)
        if (!isLoopback(parsed.hostname)) {
          this.fail(
            new Error(
              `Kimi Code server must bind to a loopback interface. Got: ${baseUrlFromRawUrl(rawUrl)}`,
            ),
          )
          return
        }
        const urlToken = parsed.searchParams.get("token")
        if (urlToken) {
          this.tokenForRedaction = urlToken
        }
        this.pendingBaseUrl = `${parsed.protocol}//${parsed.host}`
        this.log(this.redact(`Kimi Code server listening on ${baseUrlFromRawUrl(rawUrl)}`))
      } catch (error) {
        this.fail(new Error(`Kimi Code server reported an unparseable local URL: ${rawUrl}`))
        return
      }
    }

    const tokenMatch = line.match(/^Token:\s*(\S+)/i)
    if (tokenMatch) {
      this.tokenForRedaction = tokenMatch[1]!
    }

    if (this.pendingBaseUrl && this.tokenForRedaction) {
      const connection: KimiServerConnection = {
        baseUrl: this.pendingBaseUrl,
        token: this.tokenForRedaction,
        owned: true,
      }
      const starting = this.state
      this.state = { kind: "ready", connection }
      if (starting.kind === "starting") {
        starting.resolve(connection)
      }
    }
  }

  private fail(error: Error) {
    const redacted = this.redactError(error)
    if (this.state.kind === "starting") {
      this.state.reject(redacted)
    }
    this.state = { kind: "failed", error: redacted }
    if (this.child) {
      try {
        if (!this.child.killed) {
          this.child.kill("SIGKILL")
        }
      } catch {
        // ignore
      }
      this.child = null
    }
  }

  private redact(message: string): string {
    return redactKimiServerSecret(message, this.tokenForRedaction)
  }

  private redactError(error: Error): Error {
    const redactedMessage = this.redact(error.message)
    const redacted = new Error(redactedMessage)
    redacted.stack = this.redact(error.stack ?? "")
    redacted.cause = error.cause
    return redacted
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
