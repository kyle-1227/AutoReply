$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$metadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if ($metadata.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package version.' }
$releaseRoot = Join-Path $projectRoot 'releases'
$documentation = @('README.md', '安装说明.md', '评价接入约定.md', 'PRODUCT_POSITIONING.md', '项目需求文档.md')
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

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
