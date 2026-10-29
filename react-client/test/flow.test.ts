/**
 * Headless run of the React client's approval logic (same HttpAgent + helpers the hook uses)
 * against the mock server. Prints what happened at each step.
 */
import { HttpAgent } from "@ag-ui/client";
import type { Interrupt } from "@ag-ui/core";
import { buildApprovalResume, toPendingApprovals } from "../src/approvals";
import { startMockServer, executedRefunds, receivedInputs } from "./mock-dotnet-server";

const server = await startMockServer(5199);
const url = "http://localhost:5199/refunds";
const log = (label: string, v: unknown) => console.log(`\n## ${label}\n`, typeof v === "string" ? v : JSON.stringify(v, null, 2));

function newAgent() {
  let interrupts: Interrupt[] = [];
  const agent = new HttpAgent({ url });
  agent.subscribe({ onRunFinishedEvent: (p) => { interrupts = p.outcome === "interrupt" ? p.interrupts : []; } });
  return { agent, getInterrupts: () => interrupts };
}

// 1. One refund, approved
{
  const { agent, getInterrupts } = newAgent();
  agent.addMessage({ id: crypto.randomUUID(), role: "user", content: "Refund ₹500 on ORD-1042" });
  await agent.runAgent();
  const approvals = toPendingApprovals(getInterrupts(), agent.messages);
  log("1a. after first run: approvals the UI would render", approvals.map((a) => ({ id: a.interrupt.id, tool: a.toolName, args: a.args })));
  log("1b. agent.pendingInterrupts", agent.pendingInterrupts.map((i) => i.id));
  log("1c. refunds executed before approval", executedRefunds.length);

  const resume = buildApprovalResume(approvals, { [getInterrupts()[0].id]: true })!;
  log("1d. resume payload sent", resume);
  await agent.runAgent({ resume });
  log("1e. refunds executed after approval", executedRefunds);
  log("1f. final assistant text", agent.messages.filter((m) => m.role === "assistant" && typeof m.content === "string").map((m) => m.content));
  log("1g. messages the client sent on the resume run", receivedInputs.at(-1)!.messages.map((m: any) => `${m.role}${m.toolCalls ? " +toolCalls" : ""}`));
}

// 1x. The payload the interrupt's responseSchema asks for, { approved } alone
{
  const { agent, getInterrupts } = newAgent();
  agent.addMessage({ id: crypto.randomUUID(), role: "user", content: "Refund ₹500 on ORD-1042" });
  await agent.runAgent();
  const before = executedRefunds.length;
  await agent.runAgent({ resume: [{ interruptId: getInterrupts()[0].id, status: "resolved", payload: { approved: true } }] });
  log("1x. { approved: true } without toolCall", {
    executedNow: executedRefunds.length - before,
    assistantSaid: agent.messages.filter((m) => m.role === "assistant" && typeof m.content === "string").at(-1)?.content,
  });
}

// 2. Try to send a new message while an approval is still open
{
  const { agent } = newAgent();
  agent.addMessage({ id: crypto.randomUUID(), role: "user", content: "Refund ₹500 on ORD-1043" });
  await agent.runAgent();
  agent.addMessage({ id: crypto.randomUUID(), role: "user", content: "actually, what's the status of ORD-1044?" });
  try {
    await agent.runAgent();
    log("2. new turn with open interrupt", "client allowed it");
  } catch (e) {
    log("2. new turn with open interrupt", `client threw: ${(e as Error).message}`);
  }
}

// 3. Two refunds in one message: answer only one of them
{
  const { agent, getInterrupts } = newAgent();
  agent.addMessage({ id: crypto.randomUUID(), role: "user", content: "Refund ORD-1042 and ORD-1043" });
  await agent.runAgent();
  const ints = getInterrupts();
  log("3a. interrupts from one run", ints.length);
  log("3b. our helper with one decision", buildApprovalResume(toPendingApprovals(ints, agent.messages), { [ints[0].id]: true }));
  try {
    await agent.runAgent({ resume: [{ interruptId: ints[0].id, status: "resolved", payload: { approved: true } }] });
    log("3c. partial resume sent directly", "client allowed it");
  } catch (e) {
    log("3c. partial resume sent directly", `client threw: ${(e as Error).message}`);
  }
}

// 4. "Page refresh": a brand-new agent instance tries to answer the old interrupt
{
  const { agent: original, getInterrupts } = newAgent();
  original.addMessage({ id: crypto.randomUUID(), role: "user", content: "Refund ₹500 on ORD-1044" });
  await original.runAgent();
  const staleInterrupt = getInterrupts()[0];
  const before = executedRefunds.length;

  const fresh = new HttpAgent({ url, threadId: original.threadId }); // same thread id, but no messages
  try {
    await fresh.runAgent({ resume: [{ interruptId: staleInterrupt.id, status: "resolved", payload: { approved: true } }] });
    log("4. resume from a fresh client after 'refresh'", { executedNow: executedRefunds.length - before });
  } catch (e) {
    log("4. resume from a fresh client after 'refresh'", `client threw: ${(e as Error).message}`);
  }
}

server.close();
