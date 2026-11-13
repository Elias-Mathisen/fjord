# Builds dist\FjordSetup.exe: Fjord's own installer, updater and uninstaller (tools\installer\FjordSetup.cs).
# It carries Fjord's files (config, theme, icons) and downloads Firefox from Mozilla when it runs.
# Run:  powershell -ExecutionPolicy Bypass -File tools\build-installer.ps1   (runs build.ps1 first)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$dist = Join-Path $root 'dist'
$core = Join-Path $dist 'core'
& powershell -ExecutionPolicy Bypass -File (Join-Path $root 'build.ps1')
if ($LASTEXITCODE) { throw 'build.ps1 failed' }

# Payload: only Fjord's files from dist\core, at the same paths inside Firefox's folder
$stage = Join-Path $env:TEMP "fjord-payload-$PID"
New-Item -ItemType Directory -Force $stage | Out-Null
$zip = Join-Path $stage 'payload.zip'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
$files = @('defaults\pref\autoconfig.js', 'Fjord.cfg', 'distribution\policies.json',
           'browser\chrome\icons\default\main-window.ico', 'browser\chrome\icons\default\default.ico')
# Only one new-tab photo is packed; Fjord downloads the rest itself (photos.sys.mjs), which keeps this small
$files += Get-ChildItem "$core\fjord" -Recurse -File | Where-Object { $_.DirectoryName -ne "$core\fjord\photos" -or $_.Name -eq 'photo-001.jpg' } |
    ForEach-Object { $_.FullName.Substring($core.Length + 1) }
foreach ($f in $files) {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $core $f), ($f -replace '\\', '/'), 'Optimal') | Out-Null
}
$archive.Dispose()

# Name, publisher and version in the file's Properties: antivirus programs trust nameless programs less, and
# SignPath only signs a file whose product name is Fjord
$version = (Get-Content "$root\src\fjord\version.txt" -Raw).Trim()
$info = Join-Path $stage 'AssemblyInfo.cs'
@"
[assembly: System.Reflection.AssemblyTitle("Fjord Setup")]
[assembly: System.Reflection.AssemblyProduct("Fjord")]
[assembly: System.Reflection.AssemblyCompany("Elias Mathisen")]
[assembly: System.Reflection.AssemblyCopyright("Elias Mathisen. Mozilla Public License 2.0")]
[assembly: System.Reflection.AssemblyVersion("$version")]
[assembly: System.Reflection.AssemblyFileVersion("$version")]
[assembly: System.Reflection.AssemblyInformationalVersion("$version")]
"@ | Set-Content $info -Encoding UTF8

# The public half of the release key, so installed copies can check an update came from us (tools\make-release-key.ps1)
$keyResource = if (Test-Path "$PSScriptRoot\installer\release-key.xml") { "/resource:$PSScriptRoot\installer\release-key.xml,release-key.xml" }
$csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
$wpf = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'WPF'
$out = Join-Path $dist 'FjordSetup.exe'
& $csc /nologo /target:winexe /optimize+ /out:$out /win32icon:"$core\fjord\fjord.ico" `
    /r:"$wpf\PresentationFramework.dll" /r:"$wpf\PresentationCore.dll" /r:"$wpf\WindowsBase.dll" /r:System.Xaml.dll `
    /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:Microsoft.CSharp.dll /r:System.Core.dll `
    /resource:"$zip,payload.zip" /resource:"$root\src\fjord\branding\logo.png,logo.png" /resource:"$PSScriptRoot\installer\fjord-wide.jpg,fjord-wide.jpg" `
    $keyResource (Join-Path $PSScriptRoot 'installer\FjordSetup.cs') $info
if ($LASTEXITCODE) { throw 'Compiling the installer failed' }
Remove-Item $stage -Recurse -Force
Write-Host ("Built $out ({0:N0} MB)" -f ((Get-Item $out).Length / 1MB))
