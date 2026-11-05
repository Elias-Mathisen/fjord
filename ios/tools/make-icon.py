#!/usr/bin/env python3
"""Draws the iPhone app icon (ios/AppIcon.png): Fjord's mountains from src/icon.png, full-bleed, since iOS rounds the
corners itself. src/icon.png has the macOS look, with its own rounded corners and margin, which iOS would frame."""
import os
from PIL import Image, ImageDraw

IOS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S, K = 1024, 4  # drawn 4x larger, then scaled down for smooth edges


def edge(points):
    # The shapes in src/icon.png sit in an 824px square at (100, 100); spread them to the full square
    return [((x - 100) * S / 824 * K, (y - 100) * S / 824 * K) for x, y in points]


img = Image.new("RGB", (S * K, S * K))
draw = ImageDraw.Draw(img)
for y in range(S * K):  # the sky: light at the top, lighter towards the mountains
    t = y / (S * K)
    draw.line([(0, y), (S * K, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip((212, 229, 240), (232, 241, 247))))
bottom = [(924, 924), (100, 924)]
draw.polygon(edge([(100, 530), (306, 342), (480, 502), (654, 290), (924, 521)] + bottom), fill=(147, 185, 210))
draw.polygon(edge([(100, 662), (371, 444), (582, 631), (776, 480), (924, 582)] + bottom), fill=(58, 114, 160))
draw.polygon(edge([(100, 776), (416, 583), (924, 755)] + bottom), fill=(18, 50, 79))
img.resize((S, S), Image.LANCZOS).save(os.path.join(IOS, "AppIcon.png"))
print("AppIcon.png")
