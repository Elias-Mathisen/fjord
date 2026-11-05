# Publishes Fjord's version (src\fjord\version.txt) as a GitHub release. GitHub's machines build FjordSetup.exe
# from the pushed code and SignPath signs it for Windows (.github\workflows\build.yml); this PC then adds Fjord's own
# update signature, with the release key that never leaves it, and uploads both. Installed copies pick it up within
# 3 hours; the website's download button points to it.
# Run:  powershell -ExecutionPolicy Bypass -File tools\release.ps1 "What's new, in a sentence or two"
param([Parameter(Mandatory)][string]$Notes)
# Not 'Stop': PowerShell 5.1 would treat git's and gh's progress messages on stderr as errors; exit codes are checked
$ErrorActionPreference = 'Continue'
$repo = 'Elias-Mathisen/fjord'
$root = Split-Path $PSScriptRoot
$version = (Get-Content "$root\src\fjord\version.txt" -Raw).Trim()
$privateKey = Join-Path $env:APPDATA 'Fjord release\release-key.xml'
if (git -C $root status --porcelain -- src tools .github) { throw 'Commit your changes first, so the release matches the code on GitHub.' }
gh release view "v$version" --repo $repo *> $null
if ($LASTEXITCODE -eq 0) { throw "v$version is already released. Raise the version in src\fjord\version.txt." }
if (-not (Test-Path $privateKey)) { throw "No release key at $privateKey. Copy it back from your backup." }

git -C $root push -q origin HEAD
if ($LASTEXITCODE) { throw 'Pushing to GitHub failed' }
$sha = git -C $root rev-parse HEAD
gh workflow run build.yml --repo $repo --ref (git -C $root rev-parse --abbrev-ref HEAD)
if ($LASTEXITCODE) { throw 'Starting the build on GitHub failed' }
$run = $null
for ($i = 0; -not $run -and $i -lt 30; $i++) {
    Start-Sleep 2
    $run = gh run list --repo $repo --workflow build.yml --commit $sha --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId'
}
if (-not $run) { throw "The build didn't show up on GitHub: https://github.com/$repo/actions" }
Write-Host 'Building on GitHub. If SignPath is set up, approve the signing request on signpath.io when it asks.'
gh run watch $run --repo $repo --exit-status
if ($LASTEXITCODE) { throw "The build failed: https://github.com/$repo/actions/runs/$run" }

$out = Join-Path $root 'dist\release'
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
gh run download $run --repo $repo -n FjordSetup-signed -D $out 2> $null
if ($LASTEXITCODE) {
    gh run download $run --repo $repo -n FjordSetup-unsigned -D $out
    if ($LASTEXITCODE) { throw 'Downloading the build failed' }
}
$exe = Join-Path $out 'FjordSetup.exe'

# The signature installed copies check before they update themselves (FjordSetup.cs, SignedByFjord)
$rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
$rsa.FromXmlString([IO.File]::ReadAllText($privateKey))
[IO.File]::WriteAllBytes("$exe.sig", $rsa.SignData([IO.File]::ReadAllBytes($exe), 'SHA256'))

if ((Get-AuthenticodeSignature $exe).Status -eq 'Valid') {
    $Notes += "`n`nFree code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)."
} else {
    Write-Warning "This installer isn't signed for Windows yet (SignPath isn't set up), so Windows and antivirus programs may warn about it."
}
gh release create "v$version" $exe "$exe.sig" --repo $repo --title "Fjord $version" --notes $Notes
if ($LASTEXITCODE) { throw 'Publishing the release failed' }
Write-Host "Released Fjord $version."
