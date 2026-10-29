using AGUI.Client;
using BlazorClient.Components;
using Microsoft.Extensions.AI;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

// AG-UI responses are SSE streams that stay open for the whole agent run.
// The default 100 second HttpClient timeout would cut a slow run off mid-stream.
builder.Services.AddHttpClient("agentserver", client =>
{
    client.BaseAddress = new Uri(builder.Configuration["AgentServerUrl"] ?? "http://localhost:5100");
    client.Timeout = Timeout.InfiniteTimeSpan;
});

// Turns the AG-UI endpoint into a plain IChatClient. This is the only line that knows
// the agent lives in another process.
builder.Services.AddScoped<IChatClient>(sp =>
{
    var http = sp.GetRequiredService<IHttpClientFactory>().CreateClient("agentserver");

    // AGUIChatClient picks a new AG-UI thread id for every run unless ConversationId is set.
    // The server keeps pending approvals per thread, so an approval sent on a new thread is
    // dropped and the run fails. One id per circuit (this scope) keeps the conversation on one thread.
    var threadId = $"blazor-{Guid.NewGuid():N}";
    return new AGUIChatClient(new AGUIChatClientOptions(http, "/refunds"))
        .AsBuilder()
        .ConfigureOptions(options => options.ConversationId ??= threadId)
        .Build();
});

var app = builder.Build();

app.UseAntiforgery();
app.MapStaticAssets();
app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
