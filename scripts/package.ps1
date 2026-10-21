$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $projectRoot 'extension'
$releaseRoot = Join-Path $projectRoot 'releases'
$manifest = Get-Content -LiteralPath (Join-Path $extensionRoot 'manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$packagePath = Join-Path $releaseRoot "autoreply-edge-frontend-v$($manifest.version).zip"
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$packageContents = @((Join-Path $extensionRoot '*'), (Join-Path $projectRoot '安装说明.md'),
    (Join-Path $projectRoot '评价接入约定.md'), (Join-Path $projectRoot '验收记录.md'))
Compress-Archive -Path $packageContents -DestinationPath $packagePath -Force
Write-Output $packagePath
