#!/bin/sh
# Sets up Fjord's updater on the Mac: runs build-mac.sh --auto every 3 hours (and at login), which updates
# Firefox inside Fjord when a new version is out and Fjord is closed. Run once:  sh tools/install-updater-mac.sh
# Remove it again:  launchctl bootout gui/$(id -u)/io.github.eliasmathisen.fjord.update; rm ~/Library/LaunchAgents/io.github.eliasmathisen.fjord.update.plist
set -eu
label=io.github.eliasmathisen.fjord.update
build="$(cd "$(dirname "$0")/.." && pwd)/build-mac.sh"
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$build</string><string>--auto</string></array>
  <key>StartInterval</key><integer>10800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/Fjord-update.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/Fjord-update.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
# The same job under Fjord's old name, from before 1.0.1
launchctl bootout "gui/$(id -u)/io.github.eliasmathisen.nocturne.update" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/io.github.eliasmathisen.nocturne.update.plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Fjord will check for Firefox updates every 3 hours (log: ~/Library/Logs/Fjord-update.log)."
