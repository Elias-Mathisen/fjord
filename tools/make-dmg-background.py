#!/usr/bin/env python3
"""Draws the Fjord.dmg window's background (tools/dmg/background.png and @2x): Fjord's sky, an arrow from where Fjord
sits to where Applications sits, and a line saying to drag it there. The positions must match tools/dmg/settings.py."""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 560, 340          # the window's content, in points
APP, APPS = 150, 410     # icon centres across, at the same height
ICON_Y = 150
FONT = os.path.join(ROOT, "src", "fjord", "fonts", "Geist-Variable.woff2")


def draw(scale):
    K = scale * 4  # drawn 4x larger, then scaled down for smooth edges
    img = Image.new("RGB", (W * K, H * K))
    d = ImageDraw.Draw(img)
    for y in range(H * K):  # the sky, as in the app icon
        t = y / (H * K)
        d.line([(0, y), (W * K, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip((222, 235, 244), (240, 246, 250))))

    # The mountains along the bottom, faint, in the icon's three blues
    def ridge(points, colour):
        d.polygon([(x * K, y * K) for x, y in points] + [(W * K, H * K), (0, H * K)], fill=colour)
    ridge([(0, 300), (120, 276), (230, 296), (360, 268), (470, 290), (560, 280)], (206, 223, 235))
    ridge([(0, 318), (150, 300), (290, 316), (420, 296), (560, 312)], (190, 211, 227))

    # The arrow between the icons
    blue = (58, 114, 160)
    x0, x1, y = APP + 78, APPS - 78, ICON_Y
    d.line([(x0 * K, y * K), ((x1 - 3) * K, y * K)], fill=blue, width=3 * K)
    d.polygon([(x1 * K, y * K), ((x1 - 13) * K, (y - 8) * K), ((x1 - 13) * K, (y + 8) * K)], fill=blue)

    font = ImageFont.truetype(FONT, 17 * K)
    font.set_variation_by_name("Medium")
    text = "Drag Fjord into Applications to install it"
    d.text((W * K / 2, 256 * K), text, font=font, fill=(18, 50, 79), anchor="mm")
    return img.resize((W * scale, H * scale), Image.LANCZOS)


out = os.path.join(ROOT, "tools", "dmg")
os.makedirs(out, exist_ok=True)
draw(1).save(os.path.join(out, "background.png"), dpi=(72, 72))
draw(2).save(os.path.join(out, "background@2x.png"), dpi=(144, 144))
print("tools/dmg/background.png, background@2x.png")
