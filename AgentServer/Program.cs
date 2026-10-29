using System.ClientModel;
using AGUI.Server;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Hosting;
using Microsoft.Agents.AI.Hosting.AGUI.AspNetCore;
using Microsoft.Extensions.AI;
using OpenAI;
using OpenAI.Chat;

var builder = WebApplication.CreateBuilder(args);

// Adds the AG-UI event types to the ASP.NET Core JSON options.
builder.Services.AddAGUIServer();

// The React client runs on the Vite dev server (a different origin).
// The Blazor client calls this server from its own server process, so it never needs CORS.
builder.Services.AddCors(options => options.AddPolicy("react-dev", policy => policy
    .WithOrigins(builder.Configuration["ReactOrigin"] ?? "http://localhost:5173")
    .AllowAnyHeader()
    .AllowAnyMethod()));

// Approvals span two HTTP requests: the run that asks, and the run that resumes with the answer.
// The framework only honours an approval it recorded itself when it asked, so it needs somewhere
// to keep the session between those requests. Without a store, every approval is silently dropped.
// MapAGUIServer looks the store up by the agent's name. In-memory is fine for a sample; it is
// lost on restart and is not partitioned per user.
builder.Services.AddKeyedSingleton<AgentSessionStore>("RefundAgent", new InMemoryAgentSessionStore());

var app = builder.Build();
app.UseCors("react-dev");

// Any OpenAI-compatible endpoint works: Ollama (default), OpenAI, LM Studio, etc.
// Pick a model that supports tool calling (qwen2.5:7b and llama3.1:8b both do on Ollama).
var llm = app.Configuration.GetSection("Llm");
var chatClient = new OpenAIClient(
        new ApiKeyCredential(llm["ApiKey"] ?? "not-needed-for-ollama"),
        new OpenAIClientOptions { Endpoint = new Uri(llm["Endpoint"] ?? "http://localhost:11434/v1") })
    .GetChatClient(llm["Model"] ?? "qwen2.5:7b");

// Read-only lookup: runs without asking.
AITool getOrder = AIFunctionFactory.Create(
    OrderTools.GetOrder,
    name: "get_order",
    description: "Look up an order by its id. Returns the customer, amount and status.");

// Moves money: the agent must stop and ask a human first.
AITool refundOrder = new ApprovalRequiredAIFunction(AIFunctionFactory.Create(
    OrderTools.RefundOrder,
    name: "refund_order",
    description: "Refund an order. Amount is in rupees and must not exceed the order total."));

AIAgent refundAgent = chatClient.AsAIAgent(new ChatClientAgentOptions
{
    Name = "RefundAgent",
    Description = "Support agent that can look up orders and issue refunds after approval.",
    // AG-UI clients send the whole conversation on every run, so the session must not keep its own
    // copy as well. If it did, the approval request would appear twice on resume and the run fails.
    // The session still persists its state bag, which is where the pending approval requests live.
    ChatHistoryProvider = new InMemoryChatHistoryProvider(new InMemoryChatHistoryProviderOptions
    {
        ProvideOutputMessageFilter = history => history.Where(m => false)
    }),
    ChatOptions = new ChatOptions
    {
        Instructions = """
            You are a support agent for an online store.
            - Use get_order to look up orders before talking about them.
            - When the user asks for a refund, call refund_order directly. Do not ask for
              confirmation in text; the application collects approval from a human.
            - If a refund_order call comes back rejected, say so in one sentence and stop.
              Do not call refund_order again for the same request.
            """,
        Tools = [getOrder, refundOrder]
    }
});

// One AG-UI endpoint. Both frontends talk to this exact URL.
app.MapAGUIServer("/refunds", refundAgent);

app.MapGet("/", () => Results.Ok(new
{
    service = "Refund agent (AG-UI)",
    endpoint = "/refunds",
    refundsExecuted = OrderTools.RefundLog
}));

app.Run();

static class OrderTools
{
    private static readonly Dictionary<string, (string Customer, decimal Total, string Status)> Orders = new()
    {
        ["ORD-1042"] = ("Aarav", 2499m, "delivered"),
        ["ORD-1043"] = ("Meera", 899m, "delivered"),
        ["ORD-1044"] = ("Kabir", 15999m, "shipped")
    };

    // Every executed refund lands here, so you can check how many times the tool really ran.
    public static readonly List<string> RefundLog = [];

    public static string GetOrder(string orderId) =>
        Orders.TryGetValue(orderId, out var o)
            ? $"{orderId}: customer {o.Customer}, total ₹{o.Total}, status {o.Status}."
            : $"No order with id {orderId}.";

    public static string RefundOrder(string orderId, decimal amount, string reason)
    {
        if (!Orders.TryGetValue(orderId, out var o))
            return $"No order with id {orderId}.";
        if (amount > o.Total)
            return $"Refused: ₹{amount} is more than the order total of ₹{o.Total}.";

        var entry = $"{DateTime.Now:HH:mm:ss} refunded ₹{amount} on {orderId} ({reason})";
        lock (RefundLog) RefundLog.Add(entry);
        Console.WriteLine($">>> REFUND EXECUTED: {entry}");
        return $"Refunded ₹{amount} on {orderId}.";
    }
}
