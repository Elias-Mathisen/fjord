# Draws Fjord's icons from the logo's shapes (the same as tools\logo\fjord.svg, on a 512 grid):
#   src\icon.png                       1024px with macOS-style margins (Mac app icon)
#   src\fjord\branding\logo.png     512px, tile only (Windows icon, About window, setup)
# Run only when the logo changes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot

$ridges = @(
    @{ color = '#93b9d2'; points = 0,268, 128,150, 236,250, 344,118, 512,262, 512,512, 0,512 },
    @{ color = '#3a72a0'; points = 0,350, 168,214, 300,330, 420,236, 512,300, 512,512, 0,512 },
    @{ color = '#12324f'; points = 0,420, 196,300, 512,408, 512,512, 0,512 }
)

function Save-Tile($size, $margin, $path) {
    # The square picture first, then a smooth rounded fill with it (GDI+ clipping has jagged edges)
    $side = $size - 2 * $margin
    $k = $side / 512
    $art = New-Object Drawing.Bitmap $side, $side
    $a = [Drawing.Graphics]::FromImage($art)
    $a.SmoothingMode = 'AntiAlias'
    $a.PixelOffsetMode = 'HighQuality'
    $sky = New-Object Drawing.Drawing2D.LinearGradientBrush (New-Object Drawing.PointF 0, -1), (New-Object Drawing.PointF 0, ($side + 1)),
        ([Drawing.ColorTranslator]::FromHtml('#d4e5f0')), ([Drawing.ColorTranslator]::FromHtml('#f2f7fa'))
    $a.FillRectangle($sky, 0, 0, $side, $side)
    foreach ($r in $ridges) {
        $pts = for ($i = 0; $i -lt $r.points.Count; $i += 2) { New-Object Drawing.PointF ($r.points[$i] * $k), ($r.points[$i + 1] * $k) }
        $a.FillPolygon((New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml($r.color))), [Drawing.PointF[]]$pts)
    }
    $a.Dispose()

    $bmp = New-Object Drawing.Bitmap $size, $size
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    # Rounded square, corners 22.5% like Apple's app icon grid (rx 116 of 512)
    $d = $side * 0.453
    $tile = New-Object Drawing.Drawing2D.GraphicsPath
    $m = $margin; $e = $margin + $side - $d
    $tile.AddArc($m, $m, $d, $d, 180, 90); $tile.AddArc($e, $m, $d, $d, 270, 90)
    $tile.AddArc($e, $e, $d, $d, 0, 90); $tile.AddArc($m, $e, $d, $d, 90, 90); $tile.CloseFigure()
    $brush = New-Object Drawing.TextureBrush $art
    $brush.TranslateTransform($margin, $margin)
    $g.FillPath($brush, $tile)
    $g.Dispose()
    $bmp.Save($path, [Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Saved $path"
}

Save-Tile 1024 100 "$root\src\icon.png"
Save-Tile 512 0 "$root\src\fjord\branding\logo.png"
