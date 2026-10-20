#!/usr/bin/env bash
# Compatibility entry for clone users; skill installs carry scripts/update.sh too.
set -euo pipefail
REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$REPO_DIR/scripts/update.sh" "$@"
