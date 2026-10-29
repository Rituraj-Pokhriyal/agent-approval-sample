/**
 * Test double for the ASP.NET Core endpoint, used only to exercise the React client
 * where no .NET SDK is available. It emits the event sequence that AGUI.Server 1.0.x
 * produces for an ApprovalRequiredAIFunction call (see ChatResponseUpdateAGUIExtensions.cs
 * in ag-ui-protocol/ag-ui): TOOL_CALL_START/ARGS/END, then RUN_FINISHED with an interrupt
 * outcome whose responseSchema is { approved: boolean }.
 *
 * It mirrors what the real server (with a session store registered) does on resume, checked
 * against AgentServer on 29 Oct 2026:
 * - Interrupt ids are `ficc_<toolCallId>`.
 * - A resume entry only counts as an approval if its payload carries `toolCall`. With
 *   `{ approved }` alone the real server ignores the answer and the model just keeps talking.
 * - The server runs the tool call it recorded when it asked, not the arguments the client
 *   sends back, and honours each approval once.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { EventEncoder } from "@ag-ui/encoder";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

const APPROVAL_SCHEMA = { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] };
export const executedRefunds: string[] = [];
export const receivedInputs: RunAgentInput[] = [];
// What the real server keeps in the agent session: approvals it asked for and has not seen answered.
const pendingApprovals = new Map<string, { orderId: string; amount: number }>();

export function startMockServer(port = 5199): Promise<http.Server> {
  const encoder = new EventEncoder();
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/refunds") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body) as RunAgentInput;
    receivedInputs.push(input);

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (e: BaseEvent) => res.write(encoder.encodeSSE(e));
    const { threadId, runId } = input;
    send({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);

    const resume = (input as RunAgentInput & { resume?: { interruptId: string; status: string; payload?: any }[] }).resume;

    if (resume && resume.length > 0) {
      for (const entry of resume) {
        const recorded = pendingApprovals.get(entry.interruptId);
        const msgId = randomUUID();
        if (!entry.payload?.toolCall || !recorded) {
          // The real server drops the answer without an error. The model then replies anyway.
          send({ type: EventType.TEXT_MESSAGE_START, messageId: msgId, role: "assistant" } as BaseEvent);
          send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: msgId, delta: "The refund has been processed." } as BaseEvent);
          send({ type: EventType.TEXT_MESSAGE_END, messageId: msgId } as BaseEvent);
          continue;
        }
        pendingApprovals.delete(entry.interruptId);
        const approved = entry.status === "resolved" && entry.payload.approved === true;
        const result = approved
          ? (executedRefunds.push(`${recorded.orderId}:${recorded.amount}`), `Refunded ₹${recorded.amount} on ${recorded.orderId}.`)
          : "The user rejected this tool call.";
        send({ type: EventType.TOOL_CALL_RESULT, messageId: randomUUID(), toolCallId: entry.payload.toolCall.callId, content: result } as BaseEvent);
        send({ type: EventType.TEXT_MESSAGE_START, messageId: msgId, role: "assistant" } as BaseEvent);
        send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: msgId, delta: approved ? "Done, the refund is issued." : "Okay, I won't refund it." } as BaseEvent);
        send({ type: EventType.TEXT_MESSAGE_END, messageId: msgId } as BaseEvent);
      }
      send({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: "success" } } as BaseEvent);
      res.end();
      return;
    }

    // First turn: the model decides to call the approval-gated tool (twice if asked for two refunds).
    const last = input.messages[input.messages.length - 1] as any;
    const text = String(last?.content ?? "");
    const orders = [...text.matchAll(/ORD-\d+/g)].map((m) => m[0]);
    const interrupts = [];
    const parentMessageId = randomUUID();
    for (const orderId of orders) {
      const toolCallId = `call_${randomUUID().slice(0, 8)}`;
      send({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "refund_order", parentMessageId } as BaseEvent);
      send({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify({ orderId, amount: 500, reason: "damaged item" }) } as BaseEvent);
      send({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
      pendingApprovals.set(`ficc_${toolCallId}`, { orderId, amount: 500 });
      interrupts.push({
        id: `ficc_${toolCallId}`,
        reason: "tool_call",
        toolCallId,
        message: "Approval required for tool call: refund_order",
        responseSchema: APPROVAL_SCHEMA,
      });
    }
    send({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: "interrupt", interrupts } } as BaseEvent);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
