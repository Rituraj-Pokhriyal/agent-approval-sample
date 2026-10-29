# Field notes: approval flow, Blazor vs React, same ASP.NET Core agent

Run on 29 Oct 2026, Windows 11, .NET SDK 11.0.100-rc.3.26522.148, Ollama `qwen2.5:7b`, Node 24.
Packages: Microsoft.Agents.AI.Hosting.AGUI.AspNetCore 1.26.0-preview.261023.1, Microsoft.Agents.AI(.OpenAI) 1.26.0,
AGUI.Server / AGUI.Client 1.0.1, Microsoft.Extensions.AI 10.10.0, @ag-ui/client 1.0.x.

## Headline

Approval did not work out of the box in either client. Clicking Approve never ran the tool, and nothing showed an
error. The worst version: the model replied "The refund has been processed." while the refund log stayed empty.

It took four separate fixes (two server, one per client) to make Approve actually run `refund_order`.

## What broke, in the order I hit it

**1. The server threw every approval away (server).**
`ApprovalResponseBindingChatClient` (on by default in Agent Framework) only honours an approval it recorded itself
when it asked. It records that in the agent session. `MapAGUIServer` keeps no session between HTTP requests unless
you register an `AgentSessionStore` keyed by the agent's name. Without one, the approval is treated as forged and
dropped. The only trace is a warning that says to "register an AgentSessionStore", and the sample had no logger
wired to that client, so I saw nothing. I found it by decompiling.

Fix (AgentServer/Program.cs):
```csharp
builder.Services.AddKeyedSingleton<AgentSessionStore>("RefundAgent", new InMemoryAgentSessionStore());
```
`AgentSessionStore` is marked experimental (`MAAI001`), so it also needs a NoWarn.

**2. Then the session stored the conversation twice (server).**
With a store registered, the session also persists chat history. AG-UI clients send the whole history on every run,
and the resume decoder adds the approval request again. Same request id twice, and `FunctionInvokingChatClient`
throws "An item with the same key has already been added". The client just gets `RUN_ERROR StreamingError`.
The exception is only recorded on an OpenTelemetry Activity, never logged.

Fix: keep the session (for pending approvals) but don't let it provide history:
```csharp
ChatHistoryProvider = new InMemoryChatHistoryProvider(new InMemoryChatHistoryProviderOptions
{
    ProvideOutputMessageFilter = history => history.Where(m => false)
}),
```

**3. React: the interrupt's own schema is a trap.**
Every interrupt advertises `responseSchema: { approved: boolean }`. Send exactly that and AGUI.Server does not treat
it as a tool approval at all. It only does if the payload also carries `toolCall: { callId, name, arguments }`.
Otherwise the answer becomes a generic interrupt response nobody handles, the tool never runs, and the model happily
says the refund was processed. No error anywhere.

Fix (react-client/src/approvals.ts): include `toolCall` in each resume payload.

**4. Blazor: a new thread on every run, and the error is hidden.**
Blazor's `AGUIChatClient` did send `toolCall`, but under a brand-new AG-UI thread id
(`thread_786R...` for the ask, `thread_fHKQ...` for the approval). The server keeps pending approvals per thread, so
it had nothing to match. The server returned `RUN_ERROR` and the Blazor card just said "Approved". No reply, no
error, no refund.

Fix (BlazorClient/Program.cs): pin `ChatOptions.ConversationId` per circuit, which `AGUIChatClient` maps to the
thread id:
```csharp
var threadId = $"blazor-{Guid.NewGuid():N}";
return new AGUIChatClient(...).AsBuilder()
    .ConfigureOptions(options => options.ConversationId ??= threadId)
    .Build();
```

## Good news: the server checks what was approved

After the fixes I sent an approval whose `toolCall.arguments` said ₹2000 instead of the ₹500 on the card. The server
ran ₹500. It executes the call it recorded, not what the client sends back. That is the point of fix 1, and why
turning binding off (`DisableApprovalResponseBinding = true`, the other "fix") is the wrong answer.

## The six tests

| Test | React | Blazor |
|---|---|---|
| 1/2. Refund ₹500 on ORD-1042, approve | Works after fixes. Card, Approve, tool result "Refunded ₹500 on ORD-1042", one log entry. No CORS issues. | Works after fixes. Same result. Before fix 4: card said "Approved", nothing happened. |
| 3. Two refunds in one message | Two cards. Clicking one shows "Approved, waiting for the rest"; nothing is sent until both are decided. Approve 1042 + reject 1043: one refund ran, one rejected. | Two cards. Also holds the first decision until both are answered (no request sent after the first click). |
| 4. Refresh mid-approval | Card and conversation gone. Nothing ran. | Same. Card gone, nothing ran. |
| 5. Reject | Agent says "The refund for ORD-1043 was not processed." and stops. | Clean single reject: one sentence, stops. But see the retry below. |
| 6. Raw curl | Below. | |

Refresh detail: neither client stores anything, and both start a new thread id on reload, so the approval is lost.
The server still holds the pending approval for the old thread in memory. It would only be auto-rejected if that
thread ever ran again, which it won't.

## The model is why the card matters

All with qwen2.5:7b, instructions say "use get_order before talking about orders" and "don't retry a rejected refund".

- "Refund ORD-1042 and ORD-1043 in full": it skipped `get_order` and invented amounts. React run: ₹1599 and ₹2399
  (real totals ₹2499 and ₹899). Blazor run: ₹15800 for both.
- Blazor run continued: I approved 1042 at ₹15800 and rejected 1043. The tool refused 1042 ("₹15800 is more than the
  order total of ₹2499"). The model then told the user it was **1043** that was refused for the amount (mixing up the
  human rejection and the tool refusal), and on its own proposed 1042 again at ₹2499. I rejected that. It then
  proposed 1043 at ₹2499 (nearly 3x the order). Rejected again; then it stopped. Three approval cards from one
  request, two of them retries the instructions said not to make.
- It wrote "ORDER-1042" in one confirmation.
- Takeaway: the tool's own limit check and the human card each caught something the other didn't. Trust the tool
  result and the log, not the model's summary.

## Raw wire format (README curl), rawEvent stripped

```
data: {"type":"RUN_STARTED","threadId":"thread-curl-1","runId":"run-1","protocolVersion":"1.0"}
data: {"type":"TEXT_MESSAGE_START","messageId":"chatcmpl-633","role":"assistant","name":"RefundAgent"}
data: {"type":"TEXT_MESSAGE_END","messageId":"chatcmpl-633"}
data: {"type":"TOOL_CALL_START","toolCallId":"call_86klew6k","toolCallName":"refund_order","parentMessageId":"chatcmpl-633"}
data: {"type":"TOOL_CALL_ARGS","toolCallId":"call_86klew6k","delta":"{\"orderId\":\"ORD-1042\",\"amount\":500,\"reason\":\"Customer received damaged item\"}"}
data: {"type":"TOOL_CALL_END","toolCallId":"call_86klew6k"}
data: {"type":"RUN_FINISHED","threadId":"thread-curl-1","runId":"run-1","outcome":{"type":"interrupt","interrupts":[{"id":"ficc_call_86klew6k","reason":"tool_call","message":"Approval required for tool call: refund_order","toolCallId":"call_86klew6k","responseSchema":{"type":"object","properties":{"approved":{"type":"boolean"}},"required":["approved"]}}]},"usage":[...]}
```

- An empty assistant text message comes before the tool call.
- Every event also carries a `rawEvent` with the full .NET `ChatResponseUpdate`, so the tool call is repeated four
  times. These seven events are 4,156 bytes.

The resume that works (what the React client now sends):
```json
"resume": [{ "interruptId": "ficc_call_...", "status": "resolved",
  "payload": { "approved": true, "toolCall": { "callId": "call_...", "name": "refund_order",
    "arguments": { "orderId": "ORD-1042", "amount": 500, "reason": "..." } } } }]
```
Resume response: `TOOL_CALL_START/ARGS/END`, `TOOL_CALL_RESULT "Refunded ₹500 on ORD-1042."`, assistant text,
`RUN_FINISHED success`.

## Corrections to the earlier claims (from the mock, before any real run)

1. "Approval doesn't pause the run; Approve starts a new run." Confirmed on the real server.
2. "The server remembers nothing between runs; the client must send back the assistant tool-call message."
   **Wrong for a working setup.** The server must remember (fix 1), and the assistant message is optional: resume
   worked with and without it.
3. "React has to join the interrupt's toolCallId back to the messages." Confirmed, and it must also send the joined
   call back in the payload (fix 3).
4. "The JS client throws on a new message while an approval is open, and on a partial answer." Confirmed
   ("Thread has 1 pending interrupt(s) not addressed by resume").

The old mock used `approval_` ids (real: `ficc_`) and ran the tool from `{ approved }` alone, so `npm test` passed
while the real flow was broken. It now mirrors the real server.

## Setup friction (not article material, just so you know)

- `Program.cs` was missing `using OpenAI.Chat;` (fixed yesterday).
- Blazor needed `Properties/launchSettings.json` to run in Development, or `blazor.web.js` returned 500.
- Windows Smart App Control blocked some AgentServer builds with no code problem; a different spelling of the same
  setting loaded fine.
