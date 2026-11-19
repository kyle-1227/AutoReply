$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $root 'releases'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.8 x64 compiler not found.' }
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$application = Join-Path $releaseRoot 'AutoReply-Install.exe'
$source = Join-Path $root 'installer\Bootstrapper.cs'
$worker = Join-Path $PSScriptRoot 'offline-update.mjs'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll "/resource:$worker,AutoReply.OfflineUpdate" "/out:$application" $source
if ($LASTEXITCODE -ne 0) { throw 'AutoReply bootstrapper compilation failed.' }
Write-Output $application
