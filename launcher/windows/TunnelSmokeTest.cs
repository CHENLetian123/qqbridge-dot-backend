using System.Collections.Concurrent;
using System.Text.Json;

namespace GPTBotManager;

internal static class TunnelSmokeTest
{
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    public static async Task Run(string dir)
    {
        string configDir = Path.Combine(dir, "state", "tunnel-profiles"); Directory.CreateDirectory(configDir);
        string healthFile = Path.Combine(dir, "health.url");
        File.WriteAllText(Path.Combine(configDir, "qq-dot.yaml"), JsonSerializer.Serialize(new { health = new { url_file = healthFile } }));
        var runtime = new TunnelRuntime(dir);
        runtime.SetKey("sk-fixture-only-12345");
        Check(!runtime.Arguments.Contains(runtime.Key!), "Secret leaked to arguments");
        Check(runtime.Arguments.Contains("--log.file="), "Official stdout logging must use an empty file flag");
        Check(runtime.EnvironmentForChild()["OPENAI_API_KEY"] == null, "Proxy credential fallback was not removed");
        Check(runtime.SafeLog("error: " + runtime.Key) == "error: [redacted]", "Secret log redaction failed");
        foreach (string invalid in new[] { "https://127.0.0.1:1234/", "http://example.com:1234/", "http://127.0.0.1:1234/?key=x", "http://user:password@127.0.0.1:1234/", "http://127.0.0.1:1234/other" })
            Check(TunnelRuntime.LocalBaseUri(invalid) == null, "Unsafe health URL accepted");
        Check(TunnelRuntime.LocalBaseUri("http://127.0.0.1:1234/healthz") != null, "Valid loopback health URL rejected");
        string fixture = Path.Combine(dir, "tunnel-fixture.cjs");
        File.WriteAllText(fixture, """
            const http=require('http'),fs=require('fs');
            if(process.argv.some(a=>a.includes(process.env.CONTROL_PLANE_API_KEY)))process.exit(9);
            if(process.env.OPENAI_API_KEY)process.exit(10);
            let ready=false;
            const server=http.createServer((req,res)=>{if(req.url==='/activate'){ready=true;res.end('ok');return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({live:true,ready,components:{'control-plane':{status:ready?'ok':'starting'},mcp:{status:'unknown'}}}));});
            server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(process.env.FIXTURE_HEALTH_FILE,'http://127.0.0.1:'+server.address().port);console.log('health-ready');console.log('synthetic-key='+process.env.CONTROL_PLANE_API_KEY);});
            """);
        var lines = new ConcurrentQueue<string>();
        var environment = runtime.EnvironmentForChild(); environment["FIXTURE_HEALTH_FILE"] = healthFile;
        using var child = new ManagedProcess("node.exe", "\"" + fixture + "\"", dir, line => runtime.RecordOutput(line, lines.Enqueue), environment);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!File.Exists(healthFile) && DateTime.UtcNow < deadline) await Task.Delay(50);
        var waiting = await runtime.Probe(true);
        Check(waiting.Live && !waiting.Ready, "A running process was incorrectly marked connected");
        using (var client = new System.Net.Http.HttpClient(new System.Net.Http.HttpClientHandler { UseProxy = false }))
            await client.GetStringAsync(new Uri(waiting.BaseUri!, "activate"));
        Check((await runtime.Probe(true)).Ready, "Healthy tunnel was not marked connected");
        Check(!lines.Any(line => line.Contains(runtime.Key!)), "Secret leaked to displayed output");
        string savedLog = File.ReadAllText(Path.Combine(dir, "state", "tunnel-manager.log"));
        Check(!savedLog.Contains(runtime.Key!), "Secret leaked to saved output");
        await child.Stop();
        Check(!(await runtime.Probe(true)).Live, "Stale health file survived as a live tunnel");
        runtime.SafeLog("invalid_api_key"); Check(runtime.AuthenticationFailed, "Authentication error was not detected");
        runtime.ForgetKey(); Check(runtime.Key == null && !runtime.AuthenticationFailed, "Runtime key was not cleared");
    }
}
