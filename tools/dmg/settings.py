# The Fjord.dmg window for dmgbuild: Fjord on the left, Applications on the right, on the background
# tools/make-dmg-background.py draws (the positions here must match it).
#   dmgbuild -s tools/dmg/settings.py -D app=<path>/Fjord.app Fjord dist/Fjord.dmg

app = defines["app"]  # noqa: F821, given by dmgbuild; run from the repository's folder

format = "ULMO"  # LZMA: smallest, opens on macOS 10.15 and later
files = [app]
symlinks = {"Applications": "/Applications"}
icon_locations = {"Fjord.app": (150, 150), "Applications": (410, 150)}
background = "tools/dmg/background.png"  # dmgbuild adds background@2x.png for Retina screens

window_rect = ((200, 200), (560, 340))
default_view = "icon-view"
show_status_bar = show_tab_view = show_toolbar = show_pathbar = show_sidebar = False
icon_size = 112
text_size = 13
