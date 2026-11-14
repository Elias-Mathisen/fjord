#!/bin/sh
# Builds Fjord signed for the iPhone or iPad plugged into (or paired with) this Mac, installs it and opens it.
#   sh ios/tools/phone.sh              run it in Terminal on the Mac
# Signing needs the login keychain, which an SSH session can't use; the io.github.eliasmathisen.fjord.phone
# LaunchAgent (sh ios/tools/phone.sh --agent, once) runs this inside the logged-in session instead, so it can be
# started over SSH with: launchctl kickstart gui/$(id -u)/io.github.eliasmathisen.fjord.phone
# The log goes to /tmp/fjord-phone.log.
set -eu
IOS="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=io.github.eliasmathisen.fjord.phone

if [ "${1:-}" = "--agent" ]; then
  plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$IOS/tools/phone.sh</string></array>
  <key>StandardOutPath</key><string>/tmp/fjord-phone.log</string>
  <key>StandardErrorPath</key><string>/tmp/fjord-phone.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "Ready: launchctl kickstart gui/$(id -u)/$LABEL"
  exit 0
fi

DEVICE=$(xcrun devicectl list devices 2>/dev/null | awk '/ (connected|available)( |$)/ && /iPhone|iPad/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) { print $i; exit } }')
[ -n "$DEVICE" ] || { echo "No iPhone or iPad connected: plug it in and unlock it." >&2; exit 1; }
echo "== $(date) building for $DEVICE"
cd "$IOS"
python3 tools/prepare.py
python3 tools/make-project.py
xcodebuild -project Fjord.xcodeproj -scheme Fjord -configuration Debug -sdk iphoneos -destination "id=$DEVICE" \
  -clonedSourcePackagesDirPath "$IOS/build/packages" -allowProvisioningUpdates SYMROOT="$IOS/build" build 2>&1 | grep -E "error:|BUILD" || true
[ -d build/Debug-iphoneos/Fjord.app ] && codesign -v build/Debug-iphoneos/Fjord.app
xcrun devicectl device install app --device "$DEVICE" build/Debug-iphoneos/Fjord.app 2>&1 | grep -E "installationURL|rror" || true
xcrun devicectl device process launch --device "$DEVICE" io.github.eliasmathisen.fjord 2>&1 | grep -iE "launched|error" || true
echo "== done"
