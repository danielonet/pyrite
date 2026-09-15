#!/usr/bin/env bash
# Uninstalls the locally-installed Pyrite extension from VS Code.
#
# Usage:
#   scripts/uninstall.sh

set -euo pipefail

PUBLISHER_AND_NAME="danielonnet.pyrite"

CODE_BIN=""
for candidate in code code-insiders codium; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CODE_BIN="$candidate"
    break
  fi
done

if [ -z "$CODE_BIN" ]; then
  echo "!! Could not find a 'code' CLI on PATH."
  echo "   Uninstall manually from VS Code's Extensions view instead."
  exit 1
fi

echo "==> Uninstalling $PUBLISHER_AND_NAME with '$CODE_BIN'..."
"$CODE_BIN" --uninstall-extension "$PUBLISHER_AND_NAME"

echo "Done. Reload VS Code to complete the uninstall."
