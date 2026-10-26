using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GPTBotManager;

internal sealed record TunnelHealth(bool Live, bool Ready, string Summary, Uri? BaseUri = null)
{
    public static readonly TunnelHealth Offline = new(false, false, "未连接");
}

internal sealed class TunnelRuntime
{
    public string Executable { get; }
    public string Profile { get; }
    public string HealthFile { get; }
    public string Directory { get; }
    public bool Available => File.Exists(Executable) && File.Exists(Profile);
    public string? Key { get; private set; }
    public bool AuthenticationFailed { get; private set; }
    public TunnelHealth Health { get; private set; } = TunnelHealth.Offline;
    public DateTime NextProbe { get; private set; }
    readonly object logLock = new();

    public TunnelRuntime(string directory)
    {
        Directory = directory;
        Executable = Path.Combine(directory, "tools", "tunnel-client", "bin", "tunnel-client.exe");
        Profile = Path.Combine(directory, "state", "tunnel-profiles", "qq-dot.yaml");
        HealthFile = Path.Combine(directory, "state", "tunnel-manager-health.url");
        // setup:mcp's tunnel connection helper writes a JSON-compatible YAML profile.
        // Preserve its health URL location so existing diagnostics still work.
        try {
            using var doc = JsonDocument.Parse(File.ReadAllText(Profile));
            var file = doc.RootElement.GetProperty("health").GetProperty("url_file").GetString();
            if (!string.IsNullOrWhiteSpace(file) && Path.IsPathFullyQualified(file)) HealthFile = file;
        } catch { }
    }

    public void SetKey(string key)
    {
        key = key.Trim();
        if (!key.StartsWith("sk-", StringComparison.Ordinal) || key.Length < 16 || key.Length > 1024 || key.Any(char.IsWhiteSpace))
            throw new ArgumentException("请输入有效的 OpenAI Platform 隧道运行密钥。");
        Key = key; AuthenticationFailed = false;
    }
    public void ForgetKey() { Key = null; AuthenticationFailed = false; }

    public Dictionary<string, string?> EnvironmentForChild() => new() {
        ["CONTROL_PLANE_API_KEY"] = Key ?? throw new InvalidOperationException("请先在管理器中设置隧道密钥。"),
        // Never fall back to an unrelated model/proxy API credential.
        ["OPENAI_API_KEY"] = null,
    };

    public string Arguments => "run --profile-file " + Quote(Profile) +
        " --control-plane.api-key env:CONTROL_PLANE_API_KEY --log.file= --health.listen-addr 127.0.0.1:0 --health.url-file " + Quote(HealthFile);
    static string Quote(string value) => "\"" + value.Replace("\"", "") + "\"";

    public string SafeLog(string line)
    {
        if (Key is { Length: > 0 }) line = line.Replace(Key, "[redacted]", StringComparison.Ordinal);
        line = Regex.Replace(line, @"\bsk-[A-Za-z0-9_*.-]{6,}", "[redacted]");
        if (line.Contains("invalid_api_key", StringComparison.OrdinalIgnoreCase)) AuthenticationFailed = true;
        return line;
    }

    public void RecordOutput(string line, Action<string> display)
    {
        string safe = SafeLog(line);
        display(safe);
        try {
            lock (logLock) {
                string file = Path.Combine(Directory, "state", "tunnel-manager.log");
                if (File.Exists(file) && new FileInfo(file).Length > 2 * 1024 * 1024) File.Move(file, file + ".1", true);
                File.AppendAllText(file, safe + System.Environment.NewLine, new UTF8Encoding(false));
            }
        } catch { /* Logging must not terminate an otherwise healthy runtime. */ }
    }

    public static Uri? LocalBaseUri(string raw)
    {
        if (raw.Length > 1024 || !Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var uri) ||
            uri.Scheme != "http" || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0 ||
            (uri.AbsolutePath != "/" && uri.AbsolutePath != "/healthz") ||
            (uri.Host != "127.0.0.1" && uri.Host != "[::1]")) return null;
        return new Uri(uri.GetLeftPart(UriPartial.Authority) + "/");
    }

    public async Task<TunnelHealth> Probe(bool force = false)
    {
        if (!force && DateTime.UtcNow < NextProbe) return Health;
        NextProbe = DateTime.UtcNow.AddSeconds(3);
        Health = TunnelHealth.Offline;
        try {
            if (!File.Exists(HealthFile) || new FileInfo(HealthFile).Length > 1024) return Health;
            var origin = LocalBaseUri(await File.ReadAllTextAsync(HealthFile));
            if (origin == null) return Health;
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            using var client = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false });
            using var response = await client.GetAsync(new Uri(origin, "health?details=true"), HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode) return Health;
            using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var output = new MemoryStream();
            var buffer = new byte[4096]; int count;
            while ((count = await stream.ReadAsync(buffer, timeout.Token)) > 0) {
                if (output.Length + count > 65536) return Health;
                output.Write(buffer, 0, count);
            }
            using var doc = JsonDocument.Parse(output.ToArray());
            var root = doc.RootElement;
            bool live = root.TryGetProperty("live", out var l) && l.ValueKind == JsonValueKind.True;
            bool ready = root.TryGetProperty("ready", out var r) && r.ValueKind == JsonValueKind.True;
            if (!root.TryGetProperty("components", out var components)) return Health;
            string Status(string name) => components.TryGetProperty(name, out var c) && c.TryGetProperty("status", out var s) ? s.GetString() ?? "unknown" : "unknown";
            // The official stdio transport reports mcp=unknown even after successful calls.
            // Its aggregate ready flag is authoritative; explicit MCP failures still block green status.
            ready = live && ready && Status("control-plane") == "ok" && Status("mcp") is "ok" or "unknown";
            Health = new(live, ready, ready ? "已连接" : "等待连接 / 连接异常", origin);
        } catch { /* Missing/stale health files or an exited daemon are normal offline states. */ }
        return Health;
    }

    public bool RequestKey(IWin32Window owner)
    {
        using var form = new Form { Text = "设置 Dot 隧道密钥", ClientSize = new Size(580, 230), StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, Font = new Font("Microsoft YaHei UI", 10) };
        var note = new Label { Left = 18, Top = 16, Width = 545, Height = 75, Text = "输入有 Tunnels Read / Use 权限的 OpenAI Platform 运行密钥。\n仅保存在当前管理器内存中，用于启动和异常重连。\n关闭管理器后需重新输入；不会写入配置、日志或命令参数。" };
        var input = new TextBox { Left = 18, Top = 100, Width = 545, UseSystemPasswordChar = true, MaxLength = 1024 };
        var save = new Button { Text = "使用密钥", Left = 348, Top = 160, Width = 105, Height = 34 };
        var cancel = new Button { Text = "取消", Left = 463, Top = 160, Width = 100, Height = 34, DialogResult = DialogResult.Cancel };
        save.Click += (_, _) => {
            try { SetKey(input.Text); input.Clear(); form.DialogResult = DialogResult.OK; form.Close(); }
            catch (ArgumentException ex) { MessageBox.Show(form, ex.Message, "密钥格式"); }
        };
        form.Controls.AddRange([note, input, save, cancel]); form.AcceptButton = save; form.CancelButton = cancel;
        bool accepted = form.ShowDialog(owner) == DialogResult.OK;
        input.Clear(); return accepted;
    }
}
