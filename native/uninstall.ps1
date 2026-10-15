param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'YouTubeBilingualCache'))
$ErrorActionPreference = 'Stop'
$InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
$manifest = Join-Path $InstallDirectory 'local.youtube_bilingual.cache.json'
$registration = 'HKCU:\Software\Mozilla\NativeMessagingHosts\local.youtube_bilingual.cache'
if (Test-Path -LiteralPath $registration) {
    if ((Get-Item -LiteralPath $registration).GetValue('') -ne $manifest) { throw 'Registration points to another installation; no files changed.' }
    Remove-Item -LiteralPath $registration
}
foreach ($name in @('subtitle_cache_host.py', 'cache-host.cmd', 'local.youtube_bilingual.cache.json')) {
    $target = Join-Path $InstallDirectory $name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target }
}
Write-Output 'Cache component removed; subtitle cache files retained.'
