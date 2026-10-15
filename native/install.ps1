param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'YouTubeBilingualCache'), [string]$PythonExecutable = '')
$ErrorActionPreference = 'Stop'
if (-not $PythonExecutable) { $PythonExecutable = (Get-Command python.exe -ErrorAction Stop).Source }
$PythonExecutable = (Resolve-Path -LiteralPath $PythonExecutable).Path
& $PythonExecutable -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or later is required.' }
if (-not [IO.Path]::IsPathRooted($InstallDirectory)) { throw 'InstallDirectory must be absolute.' }
$InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'subtitle_cache_host.py') -Destination (Join-Path $InstallDirectory 'subtitle_cache_host.py') -Force
$launcher = Join-Path $InstallDirectory 'cache-host.cmd'
$launchText = "@echo off`r`n`"$PythonExecutable`" -I -X utf8 `"%~dp0subtitle_cache_host.py`"`r`n"
[IO.File]::WriteAllText($launcher, $launchText, [Text.UTF8Encoding]::new($false))
$manifest = Join-Path $InstallDirectory 'local.youtube_bilingual.cache.json'
$manifestText = @{ name='local.youtube_bilingual.cache'; description='YouTube bilingual subtitle cache'; path=$launcher; type='stdio'; allowed_extensions=@('youtube-bilingual-local@local.extension') } | ConvertTo-Json
[IO.File]::WriteAllText($manifest, $manifestText, [Text.UTF8Encoding]::new($false))
$registration = 'HKCU:\Software\Mozilla\NativeMessagingHosts\local.youtube_bilingual.cache'
New-Item -Path $registration -Force | Out-Null
Set-Item -LiteralPath $registration -Value $manifest
Write-Output "Cache component installed: $InstallDirectory"
