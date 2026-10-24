param([string]$NsisCompiler = $env:NSIS_EXE)
. (Join-Path $PSScriptRoot 'build-common.ps1')
function Get-Sha256([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

if (-not $NsisCompiler) {
    $candidates = @((Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'), (Join-Path $env:ProgramFiles 'NSIS\makensis.exe'),
        (Join-Path $env:LOCALAPPDATA 'AutoReplyBuild\tools\nsis\makensis.exe'))
    $NsisCompiler = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $NsisCompiler -or -not (Test-Path -LiteralPath $NsisCompiler)) { throw 'Install NSIS 3.13 or set NSIS_EXE for this build.' }

$payload = Reset-StagingDirectory "installer-v$($metadata.version)\payload"
$runtime = Join-Path $payload 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null

# Pinned to the official v24.14.0 SHASUMS256 entry for win-x64/node.exe.
$expectedNodeHash = '63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088'
$nodeFile = Join-Path $runtime 'node.exe'
$localNode = (Get-Command node).Source
if ((Get-Sha256 $localNode) -eq $expectedNodeHash) {
    Copy-Item -LiteralPath $localNode -Destination $nodeFile -Force
} else {
    Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.14.0/win-x64/node.exe' -OutFile $nodeFile -UseBasicParsing
}
if ((Get-Sha256 $nodeFile) -ne $expectedNodeHash) { throw 'Node runtime checksum mismatch.' }
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/nodejs/node/v24.14.0/LICENSE' -OutFile (Join-Path $runtime 'LICENSE') -UseBasicParsing

foreach ($directory in @('server', 'extension')) { Copy-Item -LiteralPath (Join-Path $projectRoot $directory) -Destination $payload -Recurse -Force }
foreach ($file in (@('package.json') + $documentation)) { Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $payload -Force }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /reference:System.Security.dll "/out:$(Join-Path $payload 'AutoReplyHost.exe')" (Join-Path $projectRoot 'installer\NativeHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native launcher compilation failed.' }

$publicKey = [Convert]::FromBase64String((Get-Content -LiteralPath (Join-Path $payload 'extension\manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json).key)
$sha = [Security.Cryptography.SHA256]::Create()
try { $digest = $sha.ComputeHash($publicKey) } finally { $sha.Dispose() }
$extensionId = -join ($digest[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
$hostManifest = [ordered]@{name='com.autoreply.workflow';description='AutoReply workflow';path='AutoReplyHost.exe';type='stdio';allowed_origins=@("chrome-extension://$extensionId/")}
$hostManifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $payload 'native-host.json') -Encoding ASCII

$outputFile = Join-Path $releaseRoot "AutoReply-Setup-$($metadata.version)-win-x64.exe"
& $NsisCompiler "/DAPP_VERSION=$($metadata.version)" "/DPAYLOAD=$payload" "/DOUTPUT=$outputFile" (Join-Path $projectRoot 'installer\setup.nsi')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
Write-Output $outputFile
