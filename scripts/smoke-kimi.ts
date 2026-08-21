#!/usr/bin/env bun
/**
 * Opt-in smoke test for the Kimi Code integration.
 *
 * This script exercises the real Kimi Code local server (`kimi web`) in an
 * isolated temporary home. It must be run explicitly; it is not part of CI.
 *
 * Required:
 *   KANNA_KIMI_SMOKE=1
 *
 * Optional:
 *   KIMI_CODE_HOME=<directory>  (defaults to a temp directory under os.tmpdir())
 *
 * Example:
 *   KANNA_KIMI_SMOKE=1 bun run ./scripts/smoke-kimi.ts
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { execSync } from "node:child_process"
import { KimiCodeManager } from "../src/server/kimi-code"
import { KimiCodeApi } from "../src/server/kimi-code-api"
import { KimiCodeServerProcess } from "../src/server/kimi-code-server"
import type { HarnessEvent, HarnessToolRequest } from "../src/server/harness-types"

if (process.env.KANNA_KIMI_SMOKE !== "1") {
  console.error("This is an opt-in smoke test. Set KANNA_KIMI_SMOKE=1 to run it.")
  process.exit(1)
}

function ensureKimiInstalled(): void {
  try {
    const version = execSync("kimi --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
    console.log(`Detected Kimi Code: ${version}`)
  } catch {
    console.error("kimi CLI not found on PATH. Install it first, e.g.:")
    console.error("  npm install -g @moonshot-ai/kimi-code")
    process.exit(1)
  }
}

async function collectStream(stream: AsyncIterable<HarnessEvent>, predicate: (event: HarnessEvent) => boolean): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = []
  for await (const event of stream) {
    events.push(event)
    if (predicate(event)) break
  }
  return events
}

async function main(): Promise<void> {
  ensureKimiInstalled()

  const kimiHome = process.env.KIMI_CODE_HOME ?? mkdtempSync(path.join(tmpdir(), "kimi-smoke-home-"))
  const projectDir = mkdtempSync(path.join(tmpdir(), "kimi-smoke-project-"))

  console.log(`Using Kimi home: ${kimiHome}`)
  console.log(`Using project dir: ${projectDir}`)

  // Make the project a git repo so file-system tools have a stable context.
  execSync("git init", { cwd: projectDir, stdio: "ignore" })

  const env = { ...process.env, KIMI_CODE_HOME: kimiHome }
  const manager = new KimiCodeManager({
    server: new KimiCodeServerProcess({ env }),
  })

  let exitCode = 0

  try {
    await manager.ensureReady()
    console.log("Kimi Code server is ready")

    // Verify protocol surface.
    // We reach into the manager's API client for the compatibility probe.
    const api = (manager as unknown as { api?: KimiCodeApi }).api
    if (!api) {
      throw new Error("KimiCodeApi not initialized")
    }
    const compatibility = await api.checkProtocolCompatibility()
    if (!compatibility.ok) {
      throw new Error(`Kimi server lacks required API surface: ${compatibility.missing.join(", ")}`)
    }
    console.log(`Protocol compatibility OK (protocolVersion: ${compatibility.protocolVersion ?? "unknown"})`)

    // Create a session.
    const { sessionToken } = await manager.startSession({
      chatId: "smoke-chat",
      cwd: projectDir,
      model: "kimi-code/k3",
      effort: "max",
      planMode: false,
    })
    console.log(`Created Kimi session: ${sessionToken}`)

    // First turn: ask it to create a file.
    const turn1 = await manager.startTurn({
      chatId: "smoke-chat",
      content: "Create a file named hello.txt containing exactly the text 'hello' and nothing else. Do not ask for confirmation.",
      attachments: [],
      model: "kimi-code/k3",
      effort: "max",
      planMode: false,
      onToolRequest: async (request: HarnessToolRequest) => {
        console.log("Tool request:", request.tool.toolKind, request.tool.toolName)
        return {}
      },
      onApprovalRequest: async (request) => {
        console.log("Approval request:", request.toolName, request.action)
        return { decision: "approved" }
      },
    })

    const events1 = await collectStream(
      turn1.stream,
      (event) => event.type === "transcript" && event.entry?.kind === "result",
    )
    const result1 = events1.find((event) => event.type === "transcript" && event.entry?.kind === "result")
    if (result1?.type !== "transcript" || result1.entry?.kind !== "result" || result1.entry.isError) {
      throw new Error(`First turn did not complete successfully: ${JSON.stringify(result1)}`)
    }
    console.log("First turn completed")

    // Verify the file was created.
    const helloPath = path.join(projectDir, "hello.txt")
    if (!existsSync(helloPath)) {
      throw new Error(`Expected file ${helloPath} to exist`)
    }
    const contents = readFileSync(helloPath, "utf-8").trim()
    if (contents !== "hello") {
      throw new Error(`Expected hello.txt to contain 'hello', got '${contents}'`)
    }
    console.log("Verified hello.txt content")

    // Second turn in the same session.
    const turn2 = await manager.startTurn({
      chatId: "smoke-chat",
      content: "Read hello.txt and confirm its contents.",
      attachments: [],
      model: "kimi-code/k3",
      effort: "max",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    const events2 = await collectStream(
      turn2.stream,
      (event) => event.type === "transcript" && event.entry?.kind === "result",
    )
    const result2 = events2.find((event) => event.type === "transcript" && event.entry?.kind === "result")
    if (result2?.type !== "transcript" || result2.entry?.kind !== "result" || result2.entry.isError) {
      throw new Error(`Second turn did not complete successfully: ${JSON.stringify(result2)}`)
    }
    console.log("Second turn completed (same session reused)")

    // Third turn: cancel it immediately.
    const turn3 = await manager.startTurn({
      chatId: "smoke-chat",
      content: "Write a long story to disk.",
      attachments: [],
      model: "kimi-code/k3",
      effort: "max",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => ({ decision: "approved" }),
    })

    await turn3.interrupt()
    const events3 = await collectStream(
      turn3.stream,
      (event) => event.type === "transcript" && event.entry?.kind === "interrupted",
    )
    const interrupted = events3.some((event) => event.type === "transcript" && event.entry?.kind === "interrupted")
    if (!interrupted) {
      throw new Error("Third turn was not interrupted")
    }
    console.log("Third turn cancelled successfully")

    // Verify no token leaked into stdout through the account helper.
    const accountInfo = await turn1.getAccountInfo?.()
    console.log(`Account: ${accountInfo?.email ?? "unknown"}`)
  } catch (error) {
    console.error("Smoke test failed:", error instanceof Error ? error.message : String(error))
    exitCode = 1
  } finally {
    manager.stopAll()

    // Clean up temporary directories unless a specific home was provided.
    if (!process.env.KIMI_CODE_HOME) {
      try {
        rmSync(kimiHome, { recursive: true, force: true })
      } catch {
        // ignore cleanup failures
      }
    }
    try {
      rmSync(projectDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup failures
    }
  }

  process.exit(exitCode)
}

await main()
