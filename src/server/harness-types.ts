import type { AccountInfo, AgentProvider, NormalizedToolCall, TranscriptEntry } from "../shared/types"

export interface HarnessLiveTextDelta {
  channel: "assistant" | "reasoning"
  text: string
  offset: number
}

export interface HarnessEvent {
  type: "transcript" | "session_token" | "live_text_delta"
  entry?: TranscriptEntry
  sessionToken?: string
  delta?: HarnessLiveTextDelta
}

export interface HarnessToolRequest {
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
}

export interface HarnessTurn {
  provider: AgentProvider
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<AccountInfo | null>
  interrupt: () => Promise<void>
  close: () => void
  steer?: (input: {
    content: string
    attachments: import("../shared/types").ChatAttachment[]
    model?: string
    effort?: string
    planMode?: boolean
  }) => Promise<"steered" | "started_new_turn">
}
