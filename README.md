# One agent, two frontends

One ASP.NET Core agent endpoint (`/refunds`) with an approval-gated `refund_order` tool,
called by a Blazor client (Microsoft's new AI components) and a React client (`@ag-ui/client`).

```
AgentServer/    ASP.NET Core + Microsoft Agent Framework, exposes POST /refunds over AG-UI   :5100
BlazorClient/   Blazor Web App, ChatPage + FunctionApprovalBlock                            :5200
react-client/   Vite + React 19 + @ag-ui/client HttpAgent                                   :5173
```

## Prerequisites

- The latest .NET 11 SDK you can get (RC2 is public; Microsoft's own sample now says "RC3 or later").
- Ollama with a tool-calling model: `ollama pull qwen2.5:7b`
  (or point `Llm:Endpoint` / `Llm:Model` / `Llm:ApiKey` in `AgentServer/appsettings.json`
  at any OpenAI-compatible endpoint).
- Node 20+.

## Run it

Three terminals:

```bash
cd AgentServer  && dotnet run
cd BlazorClient && dotnet run          # http://localhost:5200
cd react-client && npm install && npm run dev   # http://localhost:5173
```

`http://localhost:5100/` shows the refund log, so you can see how many times the tool really ran.

## Why approval needed four fixes

Approval over AG-UI is two HTTP requests: the run that asks ends with an interrupt, and Approve
starts a new run carrying the answer. Out of the box, Approve ran nothing in either client and no
error showed anywhere. The model still replied "The refund has been processed." These four changes
are what make it work; each one is commented where it lives.

1. **Server: register a session store** (`AgentServer/Program.cs`). Agent Framework only honours an
   approval it recorded itself, and `MapAGUIServer` keeps no session between requests without a
   keyed `AgentSessionStore`. Without one, every approval is dropped as unverifiable.
2. **Server: stop the session supplying history** (`AgentServer/Program.cs`). With a store, the
   stored history plus the replayed resume puts the same approval request in front of the model
   twice and the run fails with "An item with the same key has already been added"
   ([microsoft/agent-framework#9102](https://github.com/microsoft/agent-framework/issues/9102)).
3. **React: send the tool call back** (`react-client/src/approvals.ts`). The interrupt's
   `responseSchema` says `{ approved }`, but AGUI.Server only treats the answer as a tool approval
   when the payload also has `toolCall: { callId, name, arguments }`.
4. **Blazor: keep one thread** (`BlazorClient/Program.cs`). `AGUIChatClient` starts a new AG-UI
   thread every run unless `ChatOptions.ConversationId` is set, so the approval arrived on a thread
   the server had never seen. The card still said "Approved".

The server binds to the call it recorded, not to what the client sends back: an approval edited
from ₹500 to ₹2000 still refunds ₹500. [FIELD-NOTES.md](FIELD-NOTES.md) has the full runs, the
raw wire format, and what the model did along the way.

The session store here is in memory: it is lost on restart and is not partitioned per user. A real
deployment needs a persistent store and an `AgentIsolationKeyProvider`.

### If restore fails

The package versions match Microsoft's AgenticUI sample as of 27 Oct 2026, which targets an
RC3 build. If you're on the public RC2 SDK and restore or startup fails, use the set that
sample pinned for RC2 (14 Oct 2026):

| Package | RC2-era version |
| --- | --- |
| Microsoft.AspNetCore.Components.AI | 0.1.0-preview.1.26459.102 |
| Microsoft.AspNetCore.Components.Web (ExcludeAssets) | 11.0.0-rc.2.26504.105 |
| AGUI.Client / AGUI.Server | 1.0.0 |
| Microsoft.Agents.AI.Hosting.AGUI.AspNetCore | 1.15.0-preview.260722.1 |
| Microsoft.Agents.AI.OpenAI | 1.15.0 |

## See the raw wire format

```bash
curl -N -X POST http://localhost:5100/refunds \
  -H "Content-Type: application/json" -H "Accept: text/event-stream" \
  -d @request.json
```

## React side, tested without .NET

`react-client/test/` contains a mock that emits the same event sequence AGUI.Server produces for
an approval interrupt and handles resume the way the real server does (checked against it on
29 Oct 2026), plus a headless test of the React client's logic:

```bash
cd react-client && npm test
```
