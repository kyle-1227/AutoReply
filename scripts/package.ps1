. (Join-Path $PSScriptRoot 'build-common.ps1')
$extensionRoot = Join-Path $projectRoot 'extension'
$packagePath = Join-Path $releaseRoot "autoreply-extension-v$($metadata.version).zip"
$packageContents = @((Join-Path $extensionRoot '*')) + @($documentation | ForEach-Object { Join-Path $projectRoot $_ })
Compress-Archive -Path $packageContents -DestinationPath $packagePath -Force
Write-ReleaseIndex
Write-Output $packagePath
