import { useState } from "react";
import type { Message } from "@ag-ui/core";
import { useRefundAgent } from "./useRefundAgent";

function textOf(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return "";
}

export default function App() {
  const { messages, approvals, decisions, running, error, canSend, send, decide } = useRefundAgent();
  const [input, setInput] = useState("");

  return (
    <main>
      <h1>Refund agent, React client</h1>
      <p className="hint">
        Try: <em>Refund ₹500 on ORD-1042, the customer got a damaged item.</em>
      </p>

      <section className="log">
        {messages
          .filter((m) => (m.role === "user" || m.role === "assistant") && textOf(m))
          .map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {textOf(m)}
            </div>
          ))}
        {messages
          .filter((m) => m.role === "tool")
          .map((m) => (
            <div key={m.id} className="msg tool">
              tool result: {textOf(m)}
            </div>
          ))}
      </section>

      {approvals.map(({ interrupt, toolName, args }) => (
        <div key={interrupt.id} className="approval">
          <strong>
            The agent wants to run <code>{toolName}</code>
          </strong>
          <dl>
            {Object.entries(args).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
          </dl>
          {interrupt.id in decisions ? (
            <span className="status">{decisions[interrupt.id] ? "Approved" : "Rejected"}, waiting for the rest</span>
          ) : (
            <>
              <button className="approve" onClick={() => decide(interrupt.id, true)}>
                Approve
              </button>
              <button className="reject" onClick={() => decide(interrupt.id, false)}>
                Reject
              </button>
            </>
          )}
        </div>
      ))}

      {error && <p className="error">{error}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || !canSend) return;
          send(input.trim());
          setInput("");
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={canSend ? "Ask about an order..." : running ? "Agent is working..." : "Decide on the approval first"}
          disabled={!canSend}
        />
        <button type="submit" disabled={!canSend}>
          Send
        </button>
      </form>
    </main>
  );
}
