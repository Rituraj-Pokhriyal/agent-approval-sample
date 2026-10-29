import { useEffect, useMemo, useState } from "react";
import { HttpAgent, type RunAgentParameters } from "@ag-ui/client";
import type { Interrupt, Message } from "@ag-ui/core";
import { buildApprovalResume, toPendingApprovals } from "./approvals";

const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? "http://localhost:5100/refunds";

export function useRefundAgent() {
  // Same ASP.NET Core endpoint the Blazor client uses.
  const agent = useMemo(() => new HttpAgent({ url: AGENT_URL }), []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [interrupts, setInterrupts] = useState<Interrupt[]>([]);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sub = agent.subscribe({
      onMessagesChanged: ({ messages }) => setMessages([...messages]),
      onRunFinishedEvent: (p) => setInterrupts(p.outcome === "interrupt" ? p.interrupts : []),
      onRunErrorEvent: ({ event }) => setError(event.message),
    });
    return () => sub.unsubscribe();
  }, [agent]);

  async function run(params: RunAgentParameters = {}) {
    setRunning(true);
    setError(null);
    try {
      await agent.runAgent(params);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  function send(text: string) {
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: text });
    return run();
  }

  function decide(interruptId: string, approved: boolean) {
    const next = { ...decisions, [interruptId]: approved };
    setDecisions(next);

    const resume = buildApprovalResume(toPendingApprovals(interrupts, messages), next);
    if (!resume) return; // still waiting on other approvals from the same run

    setInterrupts([]);
    setDecisions({});
    return run({ resume });
  }

  return {
    messages,
    approvals: toPendingApprovals(interrupts, messages),
    decisions,
    running,
    error,
    // The protocol will not let you start a new turn while approvals are open.
    canSend: !running && interrupts.length === 0,
    send,
    decide,
  };
}
