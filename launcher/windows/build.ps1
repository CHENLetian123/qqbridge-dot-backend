param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectPath = Join-Path $PSScriptRoot 'GPTBotManager.csproj'
$publishPath = Join-Path $PSScriptRoot 'publish'
$projectXml = [xml][IO.File]::ReadAllText($projectPath)
$binaryName = [string]$projectXml.Project.PropertyGroup.AssemblyName + '.exe'
dotnet publish $projectPath -c Release -r win-x64 -p:SelfContained=false -p:PublishSingleFile=true -o $publishPath --nologo
if ($LASTEXITCODE -ne 0) { throw 'Manager build failed.' }
if ($OutputDirectory) {
    $destination = (Resolve-Path -LiteralPath $OutputDirectory).Path
    Copy-Item -LiteralPath (Join-Path $publishPath $binaryName) -Destination (Join-Path $destination $binaryName)
    Write-Host "Built manager in $destination"
} else {
    Write-Host "Built manager in $publishPath"
}
