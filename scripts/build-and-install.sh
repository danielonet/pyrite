#!/usr/bin/env bash
# Builds the Pyrite extension into a .vsix and installs it into your local
# VS Code, so you can test it as a real installed extension (not just via
# the F5 "Extension Development Host").
#
# Usage:
#   scripts/build-and-install.sh
#
# After it finishes, reload/restart VS Code (Cmd/Ctrl+Shift+P ->
# "Developer: Reload Window") to pick up the newly installed extension.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Working in $ROOT_DIR"

# 1. Install dependencies if needed.
if [ ! -d node_modules ]; then
  echo "==> Installing npm dependencies..."
  npm install
fi

# 2. Compile TypeScript -> out/.
echo "==> Compiling..."
npm run compile

# 3. Package the extension into a .vsix using @vscode/vsce.
#    --allow-missing-repository / --skip-license: this is a local dev
#    package, not a marketplace publish, so we don't need those.
echo "==> Packaging extension..."
VSIX_PATH="$ROOT_DIR/pyrite.vsix"
npx --yes @vscode/vsce package \
  --allow-missing-repository \
  --skip-license \
  --out "$VSIX_PATH"

echo "==> Packaged $VSIX_PATH"

# 4. Find a VS Code CLI to install into.
CODE_BIN=""
for candidate in code code-insiders codium; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CODE_BIN="$candidate"
    break
  fi
done

if [ -z "$CODE_BIN" ]; then
  echo "!! Could not find a 'code' CLI on PATH."
  echo "   Install the extension manually from VS Code:"
  echo "   Extensions view -> ... menu -> 'Install from VSIX...' -> $VSIX_PATH"
  exit 1
fi

# 5. Install (force overwrites any previously installed version).
echo "==> Installing with '$CODE_BIN --install-extension'..."
"$CODE_BIN" --install-extension "$VSIX_PATH" --force

echo
echo "Done. Reload VS Code (Cmd/Ctrl+Shift+P -> 'Developer: Reload Window')"
echo "or restart it to start using the installed Pyrite extension."
