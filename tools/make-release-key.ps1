# Makes Fjord's release key, once. Installed copies of Fjord only take an update that's signed with it.
#   Private half: %APPDATA%\Fjord release\release-key.xml  (never commit it; back it up somewhere safe: if it's lost,
#                 installed copies can't update themselves any more, and if it leaks, someone else could sign updates)
#   Public half:  tools\installer\release-key.xml          (committed; built into FjordSetup.exe)
# Run:  powershell -ExecutionPolicy Bypass -File tools\make-release-key.ps1
$ErrorActionPreference = 'Stop'
$private = Join-Path $env:APPDATA 'Fjord release\release-key.xml'
$public = Join-Path $PSScriptRoot 'installer\release-key.xml'
if (Test-Path $private) { throw "There's already a release key at $private. Making a new one would stop installed copies from updating." }
New-Item -ItemType Directory -Force (Split-Path $private) | Out-Null
$rsa = New-Object Security.Cryptography.RSACryptoServiceProvider 3072
[IO.File]::WriteAllText($private, $rsa.ToXmlString($true))
[IO.File]::WriteAllText($public, $rsa.ToXmlString($false))
Write-Host "Release key saved to $private. Back it up now; the public half is in $public."
