param([Parameter(Mandatory=$true)][string]$Assets)
$ErrorActionPreference = 'Stop'
$Assets = [IO.Path]::GetFullPath($Assets)
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('rsq-install-' + [Guid]::NewGuid().ToString('N'))
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
function Invoke-RestMethod { param([string]$Uri) return Get-Content (Join-Path $Assets 'latest.json') -Raw | ConvertFrom-Json }
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  $file = Join-Path $Assets ([IO.Path]::GetFileName(([Uri]$Uri).AbsolutePath))
  if ($OutFile) { Copy-Item $file $OutFile } else { return @{ Content = [IO.File]::ReadAllBytes($file) } }
}
try {
  $env:RSQ_INSTALL_DIR = Join-Path $temporary "installation's space 中文"
  $env:RSQ_BIN_DIR = Join-Path $temporary 'bin'
  $env:XDG_CONFIG_HOME = Join-Path $temporary 'config'
  $env:RSQ_VERSION = ''
  & ./scripts/install.ps1
  $cli = Join-Path $env:RSQ_BIN_DIR 'rsq.cmd'
  $reported = & $cli --version
  if ($LASTEXITCODE -ne 0 -or "$reported".Trim() -ne $version) { throw 'Installed version differs' }
  $schema = & $cli schema 'task get' | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $schema.command -ne 'task get') { throw 'Installed Schema differs' }
  $before = Get-Content (Join-Path $env:RSQ_INSTALL_DIR 'current') -Raw
  & ./scripts/install.ps1
  $rollback = & $cli upgrade --rollback --yes | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $rollback.status -ne 'rolled_back' -or (Get-Content (Join-Path $env:RSQ_INSTALL_DIR 'current') -Raw) -ne $before) { throw 'Rollback differs' }
  Write-Host 'Windows installation, Schema and rollback passed.'
} finally { Remove-Item $temporary -Recurse -Force -ErrorAction SilentlyContinue }
