$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$metadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if ($metadata.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package version.' }
& node (Join-Path $PSScriptRoot 'version.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'Source and documentation versions must match before packaging.' }
$releaseRoot = Join-Path $projectRoot 'releases'
$documentation = @('README.md', '安装说明.md', '评价接入约定.md', 'PRODUCT_POSITIONING.md', '项目需求文档.md')
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

function Get-Sha256([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Write-ReleaseIndex {
    $names = @("autoreply-extension-v$($metadata.version).zip", "AutoReply-Setup-$($metadata.version)-win-x64.exe")
    foreach ($name in $names) { if (-not (Test-Path -LiteralPath (Join-Path $releaseRoot $name))) { return } }
    $files = @($names | ForEach-Object {
        $path = Join-Path $releaseRoot $_
        [ordered]@{ name = $_; bytes = (Get-Item -LiteralPath $path).Length; sha256 = Get-Sha256 $path }
    })
    $index = [ordered]@{ version = $metadata.version; builtAt = [DateTime]::UtcNow.ToString('o'); files = $files } | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $releaseRoot 'CURRENT.json'), $index + [Environment]::NewLine, (New-Object Text.UTF8Encoding $false))
    "# AutoReply $($metadata.version)`n`nCurrent deliverables are listed with SHA-256 hashes in CURRENT.json. Older packages are historical; see archive/." |
        Set-Content -LiteralPath (Join-Path $releaseRoot 'README.md') -Encoding UTF8
}

# Only build staging under this repository's output directory may be reset.
function Reset-StagingDirectory([string]$RelativePath) {
    $outputRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'output')) + [IO.Path]::DirectorySeparatorChar
    $stagingPath = [IO.Path]::GetFullPath((Join-Path $outputRoot $RelativePath))
    if (-not $stagingPath.StartsWith($outputRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Build staging must stay inside the project output directory.'
    }
    if (Test-Path -LiteralPath $stagingPath) { Remove-Item -LiteralPath $stagingPath -Recurse -Force }
    New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
    return $stagingPath
}
