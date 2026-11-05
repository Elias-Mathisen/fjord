#!/bin/sh
# Builds Fjord for iOS on a Mac with Xcode.
#   sh ios/build.sh                  for the iOS Simulator (ios/build/Debug-iphonesimulator/Fjord.app)
#   sh ios/build.sh --refresh-lists  the same, with the newest block lists
# A real iPhone build needs your Apple developer account in Xcode: open ios/Fjord.xcodeproj and press Run.
set -eu
cd "$(dirname "$0")"
python3 tools/prepare.py "$@"
python3 tools/make-project.py
swift tools/check-lists.swift Fjord/Resources/ads.json Fjord/Resources/trackers.json
log="$(mktemp)"
if ! xcodebuild -project Fjord.xcodeproj -target Fjord -configuration Debug -sdk iphonesimulator \
     CODE_SIGNING_ALLOWED=NO SYMROOT="$(pwd)/build" build >"$log" 2>&1; then
  grep -E "error:|warning: .*nearly matches" "$log" | head -40
  echo "Build failed; full log: $log" >&2
  exit 1
fi
grep -E "warning:" "$log" | grep -v "Run script build phase" | head -20 || true
echo "Built: $(pwd)/build/Debug-iphonesimulator/Fjord.app"
