. (Join-Path $PSScriptRoot 'build-common.ps1')
$extensionRoot = Join-Path $projectRoot 'extension'
$manifest = Get-Content -LiteralPath (Join-Path $extensionRoot 'manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$packagePath = Join-Path $releaseRoot "autoreply-extension-v$($manifest.version).zip"
$packageContents = @((Join-Path $extensionRoot '*')) + @($documentation | ForEach-Object { Join-Path $projectRoot $_ })
Compress-Archive -Path $packageContents -DestinationPath $packagePath -Force
Write-Output $packagePath
