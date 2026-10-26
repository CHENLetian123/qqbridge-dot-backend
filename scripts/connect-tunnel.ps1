[CmdletBinding(DefaultParameterSetName='Connect')]
param(
    [Parameter(Mandatory=$true, ParameterSetName='Connect')]
    [ValidatePattern('^tunnel_[A-Za-z0-9_-]{8,100}$')]
    [string]$TunnelId,
    [Parameter(Mandatory=$true, ParameterSetName='Check')]
    [switch]$CheckLocal
)
$ErrorActionPreference = 'Stop'
$projectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$clientExe = Join-Path $projectDir 'tools\tunnel-client\bin\tunnel-client.exe'
$profileDir = Join-Path $projectDir 'state\tunnel-profiles'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $clientExe)) { throw 'Official tunnel-client is not installed in tools/tunnel-client/bin.' }
& $nodeExe (Join-Path $PSScriptRoot 'check-mcp.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Start the local Dot MCP service in GPTBot Manager first.' }
& $clientExe --version
if ($CheckLocal) { return }

# Keep real secrets out of arguments, profiles and output. The managed runtime
# inherits the process environment; after a machine restart, reconnect with a
# valid locally supplied runtime key. This script never creates an admin key.
$previousRuntimeKey = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY','Process')
try {
    if (-not $previousRuntimeKey) {
        # OPENAI_API_KEY may be a model/proxy credential that cannot use the
        # tunnel control plane. Require an explicitly supplied runtime key.
            $secureKey = Read-Host 'Enter the OpenAI tunnel runtime key locally (input hidden)' -AsSecureString
            $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
            try { $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer) }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer); $secureKey.Dispose() }
    }
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    $stdioScript = (Join-Path $PSScriptRoot 'mcp-stdio.mjs').Replace('\','/')
    $configPath = (Join-Path $projectDir 'state\mcp-config.json').Replace('\','/')
    $stdioCommand = '"' + $nodeExe.Replace('\','/') + '" "' + $stdioScript + '" --config "' + $configPath + '"'
    $profileFile = Join-Path $profileDir 'qq-dot.yaml'
    if (-not (Test-Path -LiteralPath $profileFile)) {
        & $clientExe init --sample sample_mcp_stdio_local --profile qq-dot --profile-dir $profileDir --tunnel-id $TunnelId --mcp-command $stdioCommand --control-plane-api-key-ref env:CONTROL_PLANE_API_KEY --health-listen-addr '127.0.0.1:0'
        if ($LASTEXITCODE -ne 0) { throw 'Tunnel profile preparation failed.' }
    }
    # An existing profile is never silently replaced by a different tunnel.
    $profileText = [IO.File]::ReadAllText($profileFile)
    if (-not $profileText.Contains($TunnelId)) { throw 'Existing qq-dot profile belongs to a different tunnel; inspect it explicitly.' }
    & $clientExe doctor --profile qq-dot --profile-dir $profileDir --explain
    if ($LASTEXITCODE -ne 0) { throw 'Tunnel doctor failed; check tunnel ownership, workspace association and runtime Tunnels Read/Use permissions.' }
    $connectOutput = (& $clientExe runtimes connect --alias qq-dot --profile qq-dot --profile-dir $profileDir --tunnel-id $TunnelId --mcp-command $stdioCommand --runtime-api-key env:CONTROL_PLANE_API_KEY --json | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Managed tunnel runtime did not connect.' }
    $statusOutput = (& $clientExe runtimes status qq-dot --json | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify managed tunnel runtime status.' }
    $runtimeStatus = $statusOutput | ConvertFrom-Json
    $remoteVerified = [bool]$runtimeStatus.remote -and -not $runtimeStatus.remote_error
    $summary = [ordered]@{ checkedAt=[DateTime]::UtcNow.ToString('o'); alias='qq-dot'; tunnelId=$TunnelId; processRunning=[bool]$runtimeStatus.process_running; healthy=[bool]$runtimeStatus.healthy; ready=[bool]$runtimeStatus.ready; remoteVerified=$remoteVerified }
    $summaryJson = $summary | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $projectDir 'state\tunnel-last-connect.json'),$summaryJson,[Text.UTF8Encoding]::new($false))
    if (-not $remoteVerified -or -not $runtimeStatus.process_running -or -not $runtimeStatus.healthy -or -not $runtimeStatus.ready) {
        $null = (& $clientExe runtimes stop qq-dot --json | Out-String)
        if ($runtimeStatus.remote_error -match '401|invalid_api_key') { throw 'OpenAI rejected the runtime key (401). Enter a valid OpenAI Platform runtime key locally.' }
        if ($runtimeStatus.remote_error -match '403|permission|forbidden') { throw 'The runtime key lacks tunnel access. Check Tunnels Read/Use and the tunnel organization/workspace association.' }
        throw 'Tunnel process started but the remote tunnel is not verified. The incomplete runtime was stopped.'
    }
    Write-Output $summaryJson
    Write-Host 'Remote tunnel verified. The next step is creating the private ChatGPT plugin and verifying discovery.'
}
finally {
    [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY',$previousRuntimeKey,'Process')
}
