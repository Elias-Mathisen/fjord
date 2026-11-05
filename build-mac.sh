#!/bin/sh
# Builds and installs Fjord on this Mac from this checkout's src/ (tools/install.sh with FJORD_SRC), for development.
# Quit Fjord first. Users install the latest release instead:
#   curl -fsSL https://github.com/Elias-Mathisen/fjord/releases/latest/download/install.sh | sh
set -eu
FJORD_SRC="$(cd "$(dirname "$0")" && pwd)" exec sh "$(dirname "$0")/tools/install.sh" "$@"
