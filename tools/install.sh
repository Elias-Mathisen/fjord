#!/bin/sh
# Installs Fjord on a Mac or on Linux, for this user, and keeps it up to date.
#   curl -fsSL https://github.com/Elias-Mathisen/fjord/releases/latest/download/install.sh | sh
#   sh install.sh --auto        the updater's run every 3 hours: updates only when a new Fjord or Firefox is out
#                               and Fjord is closed
#   sh install.sh --uninstall   removes Fjord and its updater; bookmarks, history and passwords are kept
#   sh install.sh --build <dir>/Fjord.app   Mac: builds the app for Fjord.dmg there, without installing it
#   sh install.sh --register    sets up the updater from this copy of the script (the Mac app runs it once)
# Downloads Firefox from Mozilla and checks Mozilla's signature, and Fjord's files from the latest GitHub release,
# checked against Fjord's release key (the Mac app is then signed on this Mac, since adding Fjord breaks Mozilla's
# signature). FJORD_SRC=<repo folder> uses that checkout's files instead (build-mac.sh); FJORD_RELEASES=<url> checks
# that releases list instead of GitHub's, for testing.
set -eu
mode="${1:-}"
REPO=Elias-Mathisen/fjord
RELEASES="${FJORD_RELEASES:-https://api.github.com/repos/$REPO/releases/latest}"
OS="$(uname -s)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say() { if [ "$mode" = --auto ]; then echo "$(date '+%F %T') $*"; else echo "$*"; fi; }
fail() { say "$*" >&2; exit 1; }
# Newer: $1 sorts after $2 as a version number
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; }
[ "$(id -u)" != 0 ] || fail "Run this without sudo: Fjord installs for your account only."

if [ "$OS" = Darwin ]; then
  APP=/Applications/Fjord.app
  [ -w /Applications ] && [ ! -d "$HOME/Applications/Fjord.app" ] || APP="$HOME/Applications/Fjord.app" # not an admin
  CORE="$APP/Contents/Resources"
  DATA="$HOME/Library/Application Support/Fjord"
  LOG="$HOME/Library/Logs/Fjord-update.log"
  ffversion() { sed -n 's/^Version=//p' "$1/Contents/Resources/application.ini" 2>/dev/null || true; }
  running() { pgrep -f "^$APP/Contents/MacOS/" >/dev/null; } # its programs, not commands that mention the path
elif [ "$OS" = Linux ]; then
  DATA="${XDG_DATA_HOME:-$HOME/.local/share}/fjord"
  CORE="$DATA/core"
  LOG="$DATA/update.log"
  ffversion() { sed -n 's/^Version=//p' "$1/application.ini" 2>/dev/null || true; }
  running() { pgrep -f "^$CORE/" >/dev/null; }
else
  fail "Fjord runs on Windows, Mac and Linux; this is $OS."
fi
UPDATER="$DATA/updater"
LABEL=io.github.eliasmathisen.fjord.update

# The updater: the script in $1, copied next to Fjord's data and run every 3 hours
register() {
  mkdir -p "$UPDATER"
  # A new file, not over the old one: the updater's own run may still be reading it
  [ "$1" = "$UPDATER/install.sh" ] || { cp "$1" "$UPDATER/install.sh.new" && mv -f "$UPDATER/install.sh.new" "$UPDATER/install.sh"; }
  [ "$mode" != --auto ] || return 0
  if [ "$OS" = Darwin ]; then
    plist="$HOME/Library/LaunchAgents/$LABEL.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$UPDATER/install.sh</string><string>--auto</string></array>
  <key>StartInterval</key><integer>10800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    # The same job under Fjord's old name, from before 1.0.1
    launchctl bootout "gui/$(id -u)/io.github.eliasmathisen.nocturne.update" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/io.github.eliasmathisen.nocturne.update.plist"
    launchctl bootstrap "gui/$(id -u)" "$plist"
  else
    units="$HOME/.config/systemd/user"
    mkdir -p "$units"
    cat > "$units/fjord-update.service" <<EOF
[Unit]
Description=Fjord updater
[Service]
Type=oneshot
ExecStart=/bin/sh "$UPDATER/install.sh" --auto
StandardOutput=append:$LOG
StandardError=append:$LOG
EOF
    cat > "$units/fjord-update.timer" <<EOF
[Unit]
Description=Check for Fjord and Firefox updates every 3 hours
[Timer]
OnStartupSec=5min
OnUnitActiveSec=3h
[Install]
WantedBy=timers.target
EOF
    if ! { systemctl --user daemon-reload && systemctl --user enable --now fjord-update.timer; } 2>/dev/null; then
      # No systemd for this user: cron instead
      { crontab -l 2>/dev/null | grep -v fjord-update; echo "17 */3 * * * /bin/sh '$UPDATER/install.sh' --auto >> '$LOG' 2>&1 # fjord-update"; } |
        crontab - 2>/dev/null || say "Couldn't set up automatic updates; run this again now and then to update Fjord."
    fi
  fi
}

# The Mac app from Fjord.dmg sets its updater up the first time it opens from Applications (Fjord.cfg)
if [ "$mode" = --register ]; then register "$0"; exit 0; fi

if [ "$mode" = --uninstall ]; then
  running && fail "Quit Fjord first, then run this again."
  if [ "$OS" = Darwin ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -rf "$HOME/Library/LaunchAgents/$LABEL.plist" "$APP" "$UPDATER"
  else
    systemctl --user disable --now fjord-update.timer 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/fjord-update.timer" "$HOME/.config/systemd/user/fjord-update.service"
    crontab -l 2>/dev/null | grep -v fjord-update | crontab - 2>/dev/null || true
    rm -rf "$CORE" "$UPDATER" "$DATA/fjord.png" "${XDG_DATA_HOME:-$HOME/.local/share}/applications/fjord.desktop"
  fi
  say "Fjord is uninstalled. Your bookmarks, history and passwords are still in $DATA; delete that folder to remove them too."
  exit 0
fi

# ---------- What's new ----------

have_fjord="$(cat "$CORE/fjord/version.txt" 2>/dev/null || true)"
have_ff="$(ffversion "${APP:-$CORE}")"
ff="$(curl -fsS https://product-details.mozilla.org/1.0/firefox_versions.json | tr ',' '\n' |
  sed -n 's/.*"LATEST_FIREFOX_VERSION": *"\([^"]*\)".*/\1/p')" || ff=""
if [ -z "$ff" ]; then
  [ -n "$have_ff" ] || fail "Couldn't reach mozilla.org to download Firefox. Check your internet connection."
  ff="$have_ff"
fi

if [ -n "${FJORD_SRC:-}" ]; then
  files="$FJORD_SRC"
  fjord="$(cat "$files/src/fjord/version.txt")"
else
  curl -fsS -H "User-Agent: Fjord updater" -o "$tmp/release.json" "$RELEASES" ||
    fail "Couldn't reach GitHub to check for Fjord's latest version."
  asset() { tr ',' '\n' < "$tmp/release.json" | sed -n "s|.*\"browser_download_url\": *\"\([^\"]*/$1\)\".*|\1|p" | head -n 1; }
  fjord="$(tr ',' '\n' < "$tmp/release.json" | sed -n 's/.*"tag_name": *"v\{0,1\}\([0-9.]*\)".*/\1/p')"
fi
if [ "$mode" = --auto ]; then
  # Nothing new, or Fjord is open: the next run tries again
  newer "$fjord" "$have_fjord" || [ "$ff" != "$have_ff" ] || exit 0
  running && exit 0
fi
[ "$mode" = --build ] || ! running || fail "Quit Fjord first, then run this again." # a build leaves it alone

if [ -z "${FJORD_SRC:-}" ]; then
  url="$(asset fjord-files.tar.gz)" sig="$(asset fjord-files.tar.gz.sig)"
  [ -n "$url" ] && [ -n "$sig" ] || fail "Fjord $fjord has no Mac and Linux files."
  curl -fsSL --retry 3 -o "$tmp/files.tar.gz" "$url" && curl -fsSL --retry 3 -o "$tmp/files.sig" "$sig" ||
    fail "Couldn't download Fjord $fjord."
  # The public half of Fjord's release key (tools/installer/release-key.xml)
  cat > "$tmp/key.pem" <<'EOF'
-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAyrkx76k+VO8t8o4Oi2lr
Qizhhj6BQhOyfpVmLemsfygUuuDX1sqglwG5zGW6o/VO77nMVcOrE+Kod1YTPYtk
tSrC4bnCefEucwpssBMFQkQbuO2gYPm/WTFXRLdgDrD9KQpVzd19lCt61+Li4ryN
qiFnsDfp+myOUI019Ie4wCOJGwDnFRtauBzD++NKR4Bl2T74rkRUJoukIE5dCm6z
j2lAC4OuFzdjMWjG6DjJ6a6tOi6cgUNT7KbHAPp6zHjkRsiKhaDtDoP7FWV6hJHV
z6b/69vVWhFsYvhdGYbh7LAuwzQaBptqWnGyP9S7hGTUeVRQKMOGYCRoR0cHCNLo
CbGgGTWLnQLGQJ87UCM+Iy/Qw5dk0ZLjsRKabnQXOnzTTaQbRSUb8aTf4OvqhSm+
ZlXMp6TS0gsDbH+87zZgghcPqOEWncw2fZ6J4H6kzhm79OGbjzzfnXiaEV+chsZG
M01eUnUPsV/43c5SswcBVOsa1IbPO2eOq0d2MaGn1ut5AgMBAAE=
-----END PUBLIC KEY-----
EOF
  command -v openssl >/dev/null || fail "Fjord needs openssl to check its downloads. Install it, then run this again."
  openssl dgst -sha256 -verify "$tmp/key.pem" -signature "$tmp/files.sig" "$tmp/files.tar.gz" >/dev/null 2>&1 ||
    fail "Fjord $fjord wasn't installed: its files aren't signed with Fjord's release key."
  mkdir "$tmp/files"
  tar -xzf "$tmp/files.tar.gz" -C "$tmp/files"
  files="$tmp/files"
  fjord="$(cat "$files/src/fjord/version.txt")"
fi
say "Installing Fjord $fjord with Firefox $ff..."

# ---------- Firefox, checked against Mozilla's signature ----------

if [ "$OS" = Darwin ]; then
  stage="$tmp/Fjord.app"
  if [ "$ff" = "$have_ff" ]; then
    ditto "$APP" "$stage"
  else
    say "Downloading Firefox from Mozilla..."
    curl -fsSL --retry 3 -o "$tmp/firefox.dmg" "https://download.mozilla.org/?product=firefox-latest-ssl&os=osx&lang=en-US" ||
      fail "Couldn't download Firefox from Mozilla."
    mkdir "$tmp/mnt"
    hdiutil attach -nobrowse -readonly -mountpoint "$tmp/mnt" "$tmp/firefox.dmg" >/dev/null
    # Mozilla's Apple team ID is 43AQ936H96
    if ! codesign --verify --deep --strict "$tmp/mnt/Firefox.app" ||
       ! codesign -dv "$tmp/mnt/Firefox.app" 2>&1 | grep -q 'TeamIdentifier=43AQ936H96'; then
      hdiutil detach "$tmp/mnt" >/dev/null
      fail "The downloaded Firefox isn't validly signed by Mozilla, so it wasn't installed."
    fi
    ditto "$tmp/mnt/Firefox.app" "$stage"
    hdiutil detach "$tmp/mnt" >/dev/null
    ff="$(ffversion "$stage")"
  fi
  R="$stage/Contents/Resources"
elif [ "$ff" = "$have_ff" ]; then
  R="$CORE"
else
  case "$(uname -m)" in
    x86_64) arch=linux-x86_64 ;;
    aarch64 | arm64) arch=linux-aarch64 ;;
    *) fail "Firefox isn't made for $(uname -m) computers." ;;
  esac
  command -v gpg >/dev/null || fail "Fjord needs gpg (GnuPG) to check Firefox's signature. Install it, then run this again."
  base="https://archive.mozilla.org/pub/firefox/releases/$ff"
  say "Downloading Firefox from Mozilla..."
  curl -fsSL --retry 3 -o "$tmp/firefox.tar.xz" "$base/$arch/en-US/firefox-$ff.tar.xz" &&
    curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" && curl -fsSL -o "$tmp/SHA256SUMS.asc" "$base/SHA256SUMS.asc" &&
    curl -fsSL -o "$tmp/KEY" "$base/KEY" || fail "Couldn't download Firefox from Mozilla."
  # The checksum list must be signed by Mozilla's release key (fingerprint 14F2 6682 D091 6CDD 81E3 7B6D 61B7 B526 D98F 0353)
  mkdir -m 700 "$tmp/gpg"
  GNUPGHOME="$tmp/gpg" gpg --batch --quiet --import "$tmp/KEY" 2>/dev/null
  GNUPGHOME="$tmp/gpg" gpg --batch --status-fd 1 --verify "$tmp/SHA256SUMS.asc" "$tmp/SHA256SUMS" 2>/dev/null |
    grep -q '^\[GNUPG:\] VALIDSIG .* 14F26682D0916CDD81E37B6D61B7B526D98F0353$' &&
    [ "$(grep " $arch/en-US/firefox-$ff.tar.xz\$" "$tmp/SHA256SUMS" | cut -d ' ' -f 1)" = "$(sha256sum "$tmp/firefox.tar.xz" | cut -d ' ' -f 1)" ] ||
    fail "The downloaded Firefox isn't validly signed by Mozilla, so it wasn't installed."
  say "Unpacking Firefox..."
  mkdir "$tmp/ff"
  tar -xJf "$tmp/firefox.tar.xz" -C "$tmp/ff"
  R="$tmp/ff/firefox"
fi

# ---------- Fjord's files ----------

# One new-tab photo comes with these; Fjord downloads the rest itself, into the profile (photos.sys.mjs)
rm -rf "$R/fjord" "$R/Fjord.cfg"
mkdir -p "$R/defaults/pref" "$R/distribution" "$R/fjord"
cp "$files/src/autoconfig.js" "$R/defaults/pref/"
cp "$files/src/Fjord.cfg" "$R/"
cp "$files/src/policies.json" "$R/distribution/"
cp -R "$files/src/fjord/." "$R/fjord/"
cp "$files/tools/install.sh" "$R/fjord/install.sh" # so the Mac app from Fjord.dmg can set up its updater (Fjord.cfg)

if [ "$OS" = Darwin ]; then
  # Icon, name and its own identity, so it never mixes with a real Firefox
  mkdir "$tmp/fjord.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$files/src/icon.png" --out "$tmp/fjord.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$files/src/icon.png" --out "$tmp/fjord.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$tmp/fjord.iconset" -o "$R/fjord.icns"
  cp "$R/fjord.icns" "$R/document.icns" # Firefox's logo on web files Fjord opens, in Finder
  P="$stage/Contents/Info.plist"
  plutil -replace CFBundleName -string Fjord "$P"
  plutil -replace CFBundleDisplayName -string Fjord "$P"
  plutil -replace CFBundleIdentifier -string io.github.eliasmathisen.fjord "$P"
  plutil -replace CFBundleIconFile -string fjord.icns "$P"
  plutil -remove CFBundleIconName "$P" 2>/dev/null || true
  # macOS takes the name from these over Info.plist (the "change your default web browser?" question, Activity Monitor)
  find "$stage" -name InfoPlist.strings | while read -r f; do
    plutil -convert xml1 "$f" && sed -i '' 's/Firefox/Fjord/g' "$f"
  done
  # Assets.car holds only Firefox's icon, which macOS 27 still shows while the app starts
  rm -f "$R/Assets.car" "$R/firefox.icns"
  # Own data folder (~/Library/Application Support/Fjord): macOS only lets the real Firefox create a "Firefox" folder
  # there, so a launcher starts Firefox with an application.ini that says Profile=Fjord
  sed -e '/^\[App\]/a\
Profile=Fjord
' -e 's/^RemotingName=.*/RemotingName=fjord/' "$R/application.ini" > "$R/browser/application.ini"
  cat > "$stage/Contents/MacOS/fjord" <<'EOF'
#!/bin/sh
# Fjord launcher: Firefox with Fjord's application.ini (-app must come first)
dir="$(cd "$(dirname "$0")" && pwd)"
# Firefox's crash helper looks in the real Firefox's data folder, which macOS blocks with a "Data Access Blocked"
# warning; Fjord sends no crash reports anyway
export MOZ_CRASHREPORTER_DISABLE=1
exec "$dir/firefox" -app "$dir/../Resources/browser/application.ini" "$@"
EOF
  chmod +x "$stage/Contents/MacOS/fjord"
  plutil -replace CFBundleExecutable -string fjord "$P"
  plutil -remove LSEnvironment "$P" 2>/dev/null || true
  # Adding Fjord breaks Mozilla's signature and Apple Silicon needs a valid one, so it's signed on this Mac (ad hoc).
  # Mozilla's provisioning profile belongs to their identity, not ours
  rm -f "$stage/Contents/embedded.provisionprofile"
  xattr -cr "$stage"
  codesign --force --deep --sign - "$stage" 2>/dev/null
  codesign --verify --deep --strict "$stage"
  if [ "$mode" = --build ]; then
    ditto "$stage" "${2:?--build needs where to put Fjord.app}"
    say "Built $2"
    exit 0
  fi

  running && fail "Quit Fjord first, then run this again."
  # Fjord was called Nocturne: carry its data over and remove the old app
  support="$HOME/Library/Application Support"
  if [ -d "$support/Nocturne" ] && [ ! -e "$support/Fjord" ]; then mv "$support/Nocturne" "$support/Fjord"; fi
  rm -rf /Applications/Nocturne.app "$APP"
  mkdir -p "$(dirname "$APP")"
  ditto "$stage" "$APP"
  # Firefox caches its translated window per profile; cleared so the new version's text shows right away
  rm -rf "$HOME/Library/Caches/Fjord/Profiles/"*/startupCache
else
  # Window icons, then the new Firefox in place of the old one (the profile folder is never touched)
  for s in 16 32 48 64 128; do cp "$files/src/icon.png" "$R/browser/chrome/icons/default/default$s.png"; done
  if [ "$R" != "$CORE" ]; then
    running && fail "Quit Fjord first, then run this again."
    mkdir -p "$DATA"
    rm -rf "$CORE.old"
    [ ! -d "$CORE" ] || mv "$CORE" "$CORE.old"
    mv "$R" "$CORE"
    rm -rf "$CORE.old"
  fi
  mkdir -p "$DATA/profile"
  rm -rf "$DATA/profile/startupCache"
  cp "$files/src/icon.png" "$DATA/fjord.png"
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$apps"
  cat > "$apps/fjord.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Fjord
GenericName=Web Browser
Comment=A private browser built on Firefox
Exec="$CORE/firefox" --name fjord --class fjord -profile "$DATA/profile" %u
Icon=$DATA/fjord.png
Terminal=false
StartupNotify=true
StartupWMClass=fjord
Categories=Network;WebBrowser;
MimeType=text/html;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
EOF
  update-desktop-database "$apps" 2>/dev/null || true
fi

# ---------- The updater ----------

register "$files/tools/install.sh"

if [ "$OS" = Darwin ]; then say "Fjord $fjord is installed in $(dirname "$APP"). Open it from Launchpad or Spotlight."
else say "Fjord $fjord is installed. Open it from your apps menu."; fi
