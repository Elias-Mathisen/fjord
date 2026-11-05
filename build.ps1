# Builds portable Fjord into .\dist: official Firefox + Fjord's config and theme.
# Run:  powershell -ExecutionPolicy Bypass -File build.ps1
# Re-run any time after editing src\. Downloads Firefox when it's missing or a newer one is out.
# Firefox's own updater is off (it would undo Fjord); tools\install-updater.ps1 runs this with -Auto every 3 hours.
param([switch]$Auto)  # -Auto: the scheduled run; does nothing unless a newer Firefox is out
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # makes Invoke-WebRequest much faster on PowerShell 5.1

$src  = Join-Path $PSScriptRoot 'src'
$dist = Join-Path $PSScriptRoot 'dist'
$core = Join-Path $dist 'core'

# Fail before touching anything if the policies file is broken
Get-Content "$src\policies.json" -Raw | ConvertFrom-Json | Out-Null

$installed = if (Test-Path "$core\firefox.exe") { (Get-Item "$core\firefox.exe").VersionInfo.ProductVersion }
try {
    $latest = (Invoke-RestMethod 'https://product-details.mozilla.org/1.0/firefox_versions.json').LATEST_FIREFOX_VERSION
} catch {
    if ($Auto -or -not $installed) { throw "Couldn't reach mozilla.org to check for Firefox updates: $_" }
    Write-Warning "Couldn't check for a newer Firefox ($_); keeping $installed"
    $latest = $installed
}
$needFirefox = $installed -ne $latest
if ($Auto -and -not $needFirefox) { exit }

if (Get-Process firefox -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$core\*" }) {
    if ($Auto) { exit }  # Fjord is open; the next run tries again
    throw 'Close Fjord first, then run the build again.'
}
if ($Auto) { Start-Transcript "$dist\update.log" -Append | Out-Null }

if ($needFirefox) {
    New-Item -ItemType Directory -Force $dist | Out-Null
    $setup = Join-Path $env:TEMP 'fjord-firefox-setup.exe'
    Write-Host "Downloading Firefox $latest from mozilla.org..."
    Invoke-WebRequest 'https://download.mozilla.org/?product=firefox-latest-ssl&os=win64&lang=en-US' -OutFile $setup

    $sig = Get-AuthenticodeSignature $setup
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Mozilla Corporation') {
        Remove-Item $setup
        throw "Downloaded installer is not validly signed by Mozilla ($($sig.Status))"
    }

    # Extract next to the old copy and swap only once it worked; the profile is separate and untouched
    Write-Host 'Extracting Firefox...'
    $stage = Join-Path $dist 'staging'
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    # Unpacked with Windows' own tar: running Mozilla's installer would pop up its "Firefox Installer" window
    New-Item -ItemType Directory -Force $stage | Out-Null
    tar -xf $setup -C $stage core
    Remove-Item $setup
    if (-not (Test-Path "$stage\core\firefox.exe")) { throw 'Extraction failed: firefox.exe not found' }
    if (Test-Path $core) { Remove-Item $core -Recurse -Force }
    Move-Item "$stage\core" $core
    Remove-Item $stage -Recurse -Force
}

Write-Host 'Applying Fjord config...'
$iconDir = "$core\browser\chrome\icons\default"
New-Item -ItemType Directory -Force "$core\defaults\pref", "$core\distribution", "$core\fjord", $iconDir, "$dist\profile" | Out-Null
Copy-Item "$src\autoconfig.js" "$core\defaults\pref\" -Force
Copy-Item "$src\Fjord.cfg"  $core -Force
Copy-Item "$src\policies.json" "$core\distribution\" -Force
Copy-Item "$src\fjord\*"    "$core\fjord\" -Recurse -Force

# App icon: the full-tile logo (made by tools\make-icon.ps1) as a multi-size .ico with PNG entries
Add-Type -AssemblyName System.Drawing
$big = [Drawing.Image]::FromFile("$src\fjord\branding\logo.png")
$entries = foreach ($size in 256, 48, 32, 16) {
    $bmp = New-Object Drawing.Bitmap $size, $size
    $sg = [Drawing.Graphics]::FromImage($bmp)
    $sg.InterpolationMode = 'HighQualityBicubic'
    $sg.DrawImage($big, 0, 0, $size, $size); $sg.Dispose()
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
    @{ Size = $size; Png = $ms.ToArray() }
}
$big.Dispose()
$ico = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $dim = [byte]($e.Size % 256)  # 0 means 256
    $w.Write($dim); $w.Write($dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$e.Png.Length); $w.Write([uint32]$offset)
    $offset += $e.Png.Length
}
foreach ($e in $entries) { $w.Write($e.Png) }
$w.Flush()
[IO.File]::WriteAllBytes("$core\fjord\fjord.ico", $ico.ToArray())
# Firefox uses these for its window/taskbar icon when present
Copy-Item "$core\fjord\fjord.ico" "$iconDir\main-window.ico" -Force
Copy-Item "$core\fjord\fjord.ico" "$iconDir\default.ico" -Force

# Own profile folder, so Fjord never touches a normal Firefox install
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut("$dist\Fjord.lnk")
$lnk.TargetPath = "$core\firefox.exe"
$lnk.Arguments = "-profile `"$dist\profile`""
$lnk.WorkingDirectory = $core
$lnk.IconLocation = "$core\fjord\fjord.ico,0"
$lnk.Save()
Remove-Item "$dist\Nocturne.lnk", "$dist\NocturneSetup.exe", "$core\nocturne", "$core\nocturne.cfg" -Recurse -Force -ErrorAction SilentlyContinue  # from before the rename

# Firefox caches its translated window in the profile; clear it so the Fjord name shows up right away
Remove-Item "$dist\profile\startupCache" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Done (Firefox $latest). Launch: $dist\Fjord.lnk"
if ($Auto) { Stop-Transcript | Out-Null }
