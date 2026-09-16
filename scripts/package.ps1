$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$files = @(
    'manifest.json', 'background.js', 'content.js', 'feed-content.js',
    'feed-bridge.js', 'gmgn-holder-bridge.js', 'fomo-auth.js', 'monitor-auth.js',
    'theme.css', 'styles.css', 'feed.css', 'extras.js', 'extras.css', 'popup.html', 'popup.js', 'popup.css',
    'README.md', 'CHANGELOG.md', 'icons'
)
$paths = $files | ForEach-Object {
    $path = Join-Path $projectDir $_
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing package file: $_" }
    $path
}
$distDir = Join-Path $projectDir 'dist'
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$archive = Join-Path $distDir "fomo-dock-v$($manifest.version).zip"
if (Test-Path -LiteralPath $archive) { throw "Archive already exists: $archive" }
Compress-Archive -LiteralPath $paths -DestinationPath $archive -CompressionLevel Optimal
Write-Output $archive
Get-FileHash -LiteralPath $archive -Algorithm SHA256
