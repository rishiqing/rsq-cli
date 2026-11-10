& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repository = 'rishiqing/rsq-cli'
$root = if ($env:RSQ_INSTALL_DIR) { $env:RSQ_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'rsq' }
$bin = if ($env:RSQ_BIN_DIR) { $env:RSQ_BIN_DIR } else { Join-Path $root 'bin' }
if (-not [IO.Path]::IsPathRooted($root) -or -not [IO.Path]::IsPathRooted($bin)) { throw '安装目录必须为绝对路径。' }
$arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($arch -eq 'x64') { $arch = 'x64' } elseif ($arch -eq 'arm64') { $arch = 'arm64' } else { throw '不支持当前 CPU 架构。' }
New-Item -ItemType Directory -Path (Join-Path $root 'versions') -Force | Out-Null
New-Item -ItemType Directory -Path $bin -Force | Out-Null
$lock = Join-Path $root '.update-lock'
# CreateNew is atomic and shares the lock name with the CLI updater.
try { $lockHandle = [IO.File]::Open($lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) } catch { throw '另一个安装或升级正在运行，请稍后重试。' }
$temporary = Join-Path $root ('.install-' + [Guid]::NewGuid().ToString('N'))
$utf8 = New-Object Text.UTF8Encoding($false)
try {
  New-Item -ItemType Directory -Path $temporary | Out-Null
  $version = $env:RSQ_VERSION
  if (-not $version) { $version = (Invoke-RestMethod "https://raw.githubusercontent.com/$repository/main/latest.json").version }
  $version = $version -replace '^v', ''
  if ($version -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9]+([.-][a-zA-Z0-9]+)*)?$') { throw 'Release 版本无效。' }
  $filename = "rsq-$version-win32-$arch.zip"
  $base = "https://github.com/$repository/releases/download/v$version"
  Write-Host "正在安装 rsq $version（Windows $arch）…"
  $response = Invoke-WebRequest "$base/SHA256SUMS" -UseBasicParsing
  $sums = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }
  $rows = @($sums -split '\r?\n' | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($filename) + '$') })
  if ($rows.Count -ne 1) { throw '缺少唯一的 SHA256 校验值。' }
  $expected = ($rows[0] -split '\s+')[0].ToLowerInvariant()
  $archive = Join-Path $temporary 'release.zip'
  Invoke-WebRequest "$base/$filename" -OutFile $archive -UseBasicParsing
  if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'SHA256 校验失败，当前安装保持不变。' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName -match '(^/|(^|/)\.\.(/|$)|\\|:)' -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw '安装包包含不安全的路径或链接。' }
    }
  } finally { $zip.Dispose() }
  $stage = Join-Path $temporary 'release'
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $stage)
  $manifest = Get-Content (Join-Path $stage 'manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.version -ne $version -or $manifest.platform -ne 'win32' -or $manifest.arch -ne $arch) { throw '安装包版本或平台不匹配。' }
  $reported = & (Join-Path $stage 'node.exe') (Join-Path $stage 'package/dist/cli.js') --version
  if ($LASTEXITCODE -ne 0 -or "$reported".Trim() -ne $version) { throw '安装版本核对失败，当前安装保持不变。' }
  $selected = "$version-win32-$arch-" + [Guid]::NewGuid().ToString('N')
  # Rename the directory atomically. PowerShell's provider may move its files
  # individually; Windows scanners can briefly hold the just-verified runtime.
  $destination = Join-Path $root "versions/$selected"
  for ($attempt = 0; ; $attempt++) {
    try { [IO.Directory]::Move($stage, $destination); break }
    catch [IO.IOException] {
      if ($attempt -ge 9 -or -not [IO.Directory]::Exists($stage) -or [IO.Directory]::Exists($destination)) { throw }
      Start-Sleep -Milliseconds 200
    }
  }
  if (Test-Path (Join-Path $root 'current')) { [IO.File]::WriteAllText((Join-Path $root 'previous'), [IO.File]::ReadAllText((Join-Path $root 'current')), $utf8) }
  [IO.File]::WriteAllText((Join-Path $root '.current.tmp'), "$selected`n", $utf8)
  if (Test-Path (Join-Path $root 'current')) { [IO.File]::Replace((Join-Path $root '.current.tmp'), (Join-Path $root 'current'), (Join-Path $temporary 'current.backup')) } else { [IO.File]::Move((Join-Path $root '.current.tmp'), (Join-Path $root 'current')) }
  $launcher = @'
@echo off
setlocal
if defined RSQ_INSTALL_DIR (set "RSQ_HOME=%RSQ_INSTALL_DIR%") else (set "RSQ_HOME=%LOCALAPPDATA%\rsq")
set /p RSQ_RELEASE=<"%RSQ_HOME%\current"
"%RSQ_HOME%\versions\%RSQ_RELEASE%\node.exe" "%RSQ_HOME%\versions\%RSQ_RELEASE%\package\dist\cli.js" %*
'@
  [IO.File]::WriteAllText((Join-Path $bin 'rsq.cmd'), $launcher, [Text.Encoding]::ASCII)
  [Environment]::SetEnvironmentVariable('RSQ_INSTALL_DIR', $root, 'User')
  $env:RSQ_INSTALL_DIR = $root
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', "$bin;$userPath", 'User') }
  if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$bin;$env:Path" }
  Write-Host "已安装 rsq $version：$bin\rsq.cmd"
} finally { $lockHandle.Dispose(); Remove-Item $lock -Force -ErrorAction SilentlyContinue; Remove-Item $temporary -Recurse -Force -ErrorAction SilentlyContinue }

}
