import { buildResumeArray } from "@ag-ui/client";
import type { Interrupt, Message, ResumeEntry } from "@ag-ui/core";

/** What the UI needs to show one approval card. */
export type PendingApproval = {
  interrupt: Interrupt;
  toolName: string;
  args: Record<string, unknown>;
};

/**
 * The interrupt only carries a toolCallId. The tool name and arguments live on the
 * assistant message that made the call, so we join the two ourselves.
 */
export function toPendingApprovals(interrupts: Interrupt[], messages: Message[]): PendingApproval[] {
  return interrupts.map((interrupt) => {
    for (const m of messages) {
      if (m.role !== "assistant" || !m.toolCalls) continue;
      const call = m.toolCalls.find((c) => c.id === interrupt.toolCallId);
      if (call) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = { raw: call.function.arguments };
        }
        return { interrupt, toolName: call.function.name, args };
      }
    }
    return { interrupt, toolName: "unknown tool", args: {} };
  });
}

/**
 * AG-UI says the resume list must answer every interrupt from the previous run.
 * Returns null until the user has decided on all of them.
 *
 * The .NET server's approval interrupts advertise the schema { approved: boolean }, but that
 * is not enough: AGUI.Server only treats a resume entry as a tool approval when the payload
 * also carries the tool call. With { approved } alone the answer is silently ignored, the tool
 * never runs, and the model carries on as if it had. The server checks the call against the one
 * it recorded, so these arguments identify the call; they cannot change what runs.
 */
export function buildApprovalResume(
  approvals: PendingApproval[],
  decisions: Record<string, boolean>,
): ResumeEntry[] | null {
  const interrupts = approvals.map((a) => a.interrupt);
  if (!interrupts.every((i) => i.id in decisions)) return null;
  return buildResumeArray(
    interrupts,
    Object.fromEntries(
      approvals.map(({ interrupt, toolName, args }) => [
        interrupt.id,
        {
          status: "resolved" as const,
          payload: {
            approved: decisions[interrupt.id],
            toolCall: { callId: interrupt.toolCallId, name: toolName, arguments: args },
          },
        },
      ]),
    ),
  );
}
