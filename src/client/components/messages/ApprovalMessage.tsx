import { useState } from "react"
import { Check, CheckCheck, ShieldAlert, X } from "lucide-react"
import type { ProcessedToolCall } from "./types"
import type { AgentApprovalResponse } from "../../../shared/types"
import { Button } from "../ui/button"
import { cn } from "../../lib/utils"
import { useTranscriptRenderOptions } from "./render-context"

interface Props {
  message: Extract<ProcessedToolCall, { toolKind: "approval" }>
  onResponse: (toolUseId: string, response: AgentApprovalResponse) => void
  isLatest: boolean
}

export function ApprovalMessage({ message, onResponse, isLatest }: Props) {
  const renderOptions = useTranscriptRenderOptions()
  const input = message.input
  const result = message.result as AgentApprovalResponse | undefined
  const rawResult = message.result as unknown as { discarded?: boolean } | undefined
  const isComplete = !!result
  const isDiscarded = rawResult?.discarded === true
  const [selectedLabel, setSelectedLabel] = useState<string | undefined>(undefined)

  if (isComplete || isDiscarded) {
    return (
      <div className="w-full">
        <div className="rounded-2xl border border-border overflow-hidden">
          <div className="font-medium text-sm p-3 px-4 pr-5 bg-muted border-b border-border flex flex-row items-center justify-between gap-3">
            <p className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
              {input.toolName ?? "Approval"}
            </p>
            <p className="text-muted-foreground">
              {isDiscarded
                ? "Discarded"
                : result?.decision === "approved"
                  ? result.scope === "session"
                    ? "Approved for session"
                    : "Approved"
                  : result?.decision === "rejected"
                    ? "Rejected"
                    : "Cancelled"}
            </p>
          </div>
          {input.action && (
            <div className="w-full p-3 pt-2.5 pl-4 pr-5 bg-background text-sm text-pretty">
              {input.action}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (renderOptions.readonly) {
    return (
      <div className="w-full">
        <div className="rounded-2xl border border-border overflow-hidden">
          <div className="font-medium text-sm p-3 px-4 pr-5 bg-muted border-b border-border flex flex-row items-center justify-between gap-3">
            <p className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
              {input.toolName ?? "Approval"}
            </p>
            <p className="text-muted-foreground">Awaiting response</p>
          </div>
          {input.action && (
            <div className="w-full p-3 pt-2.5 pl-4 pr-5 bg-background text-sm text-pretty">
              {input.action}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (!isLatest) {
    return (
      <div className="w-full py-2">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Approval pending (newer interaction active)</span>
        </div>
      </div>
    )
  }

  const hasPlanExit = input.planExit && input.planExit.options && input.planExit.options.length > 0

  return (
    <div className="w-full space-y-3">
      <div className="rounded-2xl border border-border overflow-hidden">
        <div className="font-medium text-sm p-3 px-4 pr-5 bg-muted border-b border-border flex flex-row items-center justify-between gap-3">
          <p className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            {input.toolName ?? "Approval"}
          </p>
        </div>
        {input.action && (
          <div className="w-full p-3 pt-2.5 pl-4 pr-5 bg-background text-sm text-pretty border-b border-border">
            {input.action}
          </div>
        )}
        {hasPlanExit && (
          <div className="p-3 pt-2.5 pl-4 pr-5 bg-background space-y-2">
            {input.planExit!.options!.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => setSelectedLabel(option.label)}
                className={cn(
                  "w-full text-left rounded-lg border p-3 transition-all",
                  selectedLabel === option.label
                    ? "border-foreground bg-muted"
                    : "border-border hover:border-muted-foreground"
                )}
              >
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && (
                  <p className="text-xs text-muted-foreground mt-0.5">{option.description}</p>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-end gap-2 mx-2">
        {input.options.some((option) => option.id === "approve_session") && (
          <Button
            size="sm"
            onClick={() =>
              onResponse(message.toolId, {
                decision: "approved",
                scope: "session",
                selectedLabel,
              })
            }
            className="rounded-full bg-primary text-background pr-4 md:order-last"
          >
            <CheckCheck className="h-4 w-4 mr-1.5" />
            Approve for session
          </Button>
        )}
        {input.options.some((option) => option.id === "approve") && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onResponse(message.toolId, {
                decision: "approved",
                selectedLabel,
              })
            }
            className="rounded-full border-border"
          >
            <Check className="h-4 w-4 mr-1.5" />
            Approve
          </Button>
        )}
        {input.options.some((option) => option.id === "reject") && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onResponse(message.toolId, {
                decision: "rejected",
              })
            }
            className="rounded-full border-border"
          >
            <X className="h-4 w-4 mr-1.5" />
            Reject
          </Button>
        )}
        {input.options.some((option) => option.id === "cancel") && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onResponse(message.toolId, {
                decision: "cancelled",
              })
            }
            className="rounded-full text-muted-foreground"
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
