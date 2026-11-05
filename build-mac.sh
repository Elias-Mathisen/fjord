#!/bin/sh
# Builds dist-mac/Fjord.app: official Firefox + Fjord's config, theme, name and icon.
# Run:  sh build-mac.sh            build only
#       sh build-mac.sh --install  build, then copy to /Applications (close Fjord first)
#       sh build-mac.sh --auto     the scheduled run: only when a newer Firefox is out, then install
# Re-run any time after editing src/. Downloads Firefox when it's missing or a newer one is out.
# Firefox's own updater is off (it would undo Fjord); tools/install-updater-mac.sh runs --auto every 3 hours.
set -eu
cd "$(dirname "$0")"
mode="${1:-}"

APP=dist-mac/Fjord.app
INSTALLED=/Applications/Fjord.app
R="$APP/Contents/Resources"

# Fail before touching anything if the policies file is broken
python3 -c 'import json, sys; json.load(open(sys.argv[1]))' src/policies.json

version() { sed -n 's/^Version=//p' "$1/Contents/Resources/application.ini" 2>/dev/null || true; }
latest="$(curl -fsS https://product-details.mozilla.org/1.0/firefox_versions.json |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["LATEST_FIREFOX_VERSION"])')" || latest=""
running() { pgrep -f "$INSTALLED/Contents/MacOS/" >/dev/null; }

if [ "$mode" = --auto ]; then
  # Nothing new, offline, or Fjord is open: the next run tries again
  if [ -z "$latest" ] || [ "$(version "$INSTALLED")" = "$latest" ] || running; then exit 0; fi
  echo "$(date): updating to Firefox $latest"
fi
if [ -z "$latest" ]; then
  [ -d "$APP" ] || { echo "Couldn't reach mozilla.org to download Firefox" >&2; exit 1; }
  echo "Couldn't check for a newer Firefox; keeping $(version "$APP")" >&2
elif [ -d "$APP" ] && [ "$(version "$APP")" != "$latest" ]; then
  rm -rf "$APP"  # build output only; the installed copy and the profile are elsewhere
fi

if [ ! -d "$APP" ]; then
  mkdir -p dist-mac
  dmg="$(mktemp -d)/firefox.dmg"
  echo "Downloading Firefox $latest from mozilla.org..."
  curl -fL --retry 3 -o "$dmg" "https://download.mozilla.org/?product=firefox-latest-ssl&os=osx&lang=en-US"
  mnt="$(mktemp -d)"
  hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
  # Only accept a Firefox signed by Mozilla (Apple team 43AQ936H96)
  if ! codesign --verify --deep --strict "$mnt/Firefox.app" ||
     ! codesign -dv "$mnt/Firefox.app" 2>&1 | grep -q 'TeamIdentifier=43AQ936H96'; then
    hdiutil detach "$mnt" >/dev/null
    echo "Downloaded Firefox is not validly signed by Mozilla" >&2
    exit 1
  fi
  ditto "$mnt/Firefox.app" "$APP"
  hdiutil detach "$mnt" >/dev/null
  rm -f "$dmg"
fi

echo "Applying Fjord config..."
mkdir -p "$R/defaults/pref" "$R/distribution" "$R/fjord"
cp src/autoconfig.js "$R/defaults/pref/"
cp src/Fjord.cfg "$R/"
cp src/policies.json "$R/distribution/"
cp -R src/fjord/. "$R/fjord/"

# Icon
iconset="$(mktemp -d)/fjord.iconset"
mkdir -p "$iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s src/icon.png --out "$iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) src/icon.png --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$R/fjord.icns"

# Name, icon and its own identity, so it never mixes with a real Firefox
P="$APP/Contents/Info.plist"
plutil -replace CFBundleName -string Fjord "$P"
plutil -replace CFBundleDisplayName -string Fjord "$P"
plutil -replace CFBundleIdentifier -string io.github.eliasmathisen.fjord "$P"
plutil -replace CFBundleIconFile -string fjord.icns "$P"
plutil -remove CFBundleIconName "$P" 2>/dev/null || true  # else macOS shows Firefox's icon from Assets.car

# Own data folder (~/Library/Application Support/Fjord): macOS only lets the real Firefox create a
# "Firefox" folder there, so a launcher starts Firefox with an application.ini that says Profile=Fjord.
sed -e '/^\[App\]/a\
Profile=Fjord
' -e 's/^RemotingName=.*/RemotingName=fjord/' "$R/application.ini" > "$R/browser/application.ini"
cat > "$APP/Contents/MacOS/fjord" <<'EOF'
#!/bin/sh
# Fjord launcher: Firefox with Fjord's application.ini (-app must come first)
dir="$(cd "$(dirname "$0")" && pwd)"
exec "$dir/firefox" -app "$dir/../Resources/browser/application.ini" "$@"
EOF
chmod +x "$APP/Contents/MacOS/fjord"
plutil -replace CFBundleExecutable -string fjord "$P"
plutil -remove LSEnvironment "$P" 2>/dev/null || true

# Our edits break Mozilla's signature; Apple Silicon needs a valid one, so sign it locally (ad hoc).
# Mozilla's provisioning profile belongs to their identity, not ours.
rm -f "$APP/Contents/embedded.provisionprofile"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP" 2>/dev/null
codesign --verify --deep --strict "$APP"
echo "Built: $(pwd)/$APP (Firefox $(version "$APP"))"

if [ -n "$mode" ]; then
  if running || pgrep -f /Applications/Nocturne.app/ >/dev/null; then echo "Close Fjord first, then run this again." >&2; exit 1; fi
  # Fjord was called Nocturne: carry its data over and remove the old app
  support="$HOME/Library/Application Support"
  if [ -d "$support/Nocturne" ] && [ ! -e "$support/Fjord" ]; then mv "$support/Nocturne" "$support/Fjord"; fi
  rm -rf /Applications/Nocturne.app "$INSTALLED"
  ditto "$APP" "$INSTALLED"
  # Firefox caches its translated window per profile; clear it so the Fjord name shows up right away
  rm -rf "$HOME/Library/Caches/Fjord/Profiles/"*/startupCache
  echo "Installed: $INSTALLED"
fi
