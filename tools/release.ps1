# Publishes Fjord's version (src\fjord\version.txt) as a GitHub release. GitHub's machines build FjordSetup.exe,
# Fjord.dmg, the Linux AppImages (Intel and ARM) and the files Macs and Linux update from, from the pushed code, and SignPath signs
# the Windows installer (.github\workflows\build.yml); this PC then adds Fjord's own update signatures, with the
# release key that never leaves it, and uploads them all. Installed copies pick it up within
# 3 hours; the website's download button points to it.
# Run:  powershell -ExecutionPolicy Bypass -File tools\release.ps1
# The release notes are this version's lines in src\fjord\whatsnew.json, which Fjord also shows after it updates;
# notes given after the command replace them.
param([string]$Notes)
# Not 'Stop': PowerShell 5.1 would treat git's and gh's progress messages on stderr as errors; exit codes are checked
$ErrorActionPreference = 'Continue'
$repo = 'Elias-Mathisen/fjord'
$root = Split-Path $PSScriptRoot
$version = (Get-Content "$root\src\fjord\version.txt" -Raw).Trim()
if (-not $Notes) {
    $lines = (Get-Content "$root\src\fjord\whatsnew.json" -Raw -Encoding UTF8 | ConvertFrom-Json).$version
    if (-not $lines) { throw "Add what's new in $version to src\fjord\whatsnew.json first (Fjord shows it after updating)." }
    $Notes = ($lines | ForEach-Object { "- $_" }) -join "`n"
}
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
gh run download $run --repo $repo -n fjord-files -D $out
if ($LASTEXITCODE) { throw 'Downloading the Mac and Linux files failed' }
$files = Join-Path $out 'fjord-files.tar.gz'
# install.sh straight from the release files, so the copy people download matches the one the updater gets
tar -xzf $files -C $out tools/install.sh
$install = Join-Path $out 'tools\install.sh'
foreach ($a in 'Fjord-mac', 'Fjord-linux-x86_64', 'Fjord-linux-aarch64') {
    gh run download $run --repo $repo -n $a -D $out
    if ($LASTEXITCODE) { throw "Downloading $a failed" }
}
$dmg = Join-Path $out 'Fjord.dmg'
$appimages = 'x86_64', 'aarch64' | ForEach-Object { Join-Path $out "Fjord-$_.AppImage" }

# The signatures installed copies check before they update themselves (FjordSetup.cs SignedByFjord, install.sh)
$rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
$rsa.FromXmlString([IO.File]::ReadAllText($privateKey))
foreach ($f in $exe, $files) { [IO.File]::WriteAllBytes("$f.sig", $rsa.SignData([IO.File]::ReadAllBytes($f), 'SHA256')) }

if ((Get-AuthenticodeSignature $exe).Status -eq 'Valid') {
    $Notes += "`n`nFree code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)."
} else {
    Write-Warning "This installer isn't signed for Windows yet (SignPath isn't set up), so Windows and antivirus programs may warn about it."
}
gh release create "v$version" $exe "$exe.sig" $files "$files.sig" $install $dmg @appimages --repo $repo --title "Fjord $version" --notes $Notes
if ($LASTEXITCODE) { throw 'Publishing the release failed' }
Write-Host "Released Fjord $version."
