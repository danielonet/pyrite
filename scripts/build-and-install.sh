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

# 0. @vscode/vsce (and its dependencies, e.g. @azure/identity) require
#    Node >= 20. If the shell that invoked this script resolved an older
#    system Node (common in a fresh terminal that hasn't sourced nvm, or a
#    non-interactive runner), try to pick up nvm and switch to a Node that
#    satisfies REQUIRED_NODE_MAJOR before it gets used below.
REQUIRED_NODE_MAJOR=20
node_major() {
  if command -v node >/dev/null 2>&1; then
    node -e 'console.log(process.versions.node.split(".")[0])'
  else
    echo 0
  fi
}

if [ "$(node_major)" -lt "$REQUIRED_NODE_MAJOR" ]; then
  echo "==> Node not found or too old (needs >= $REQUIRED_NODE_MAJOR); looking for nvm..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    # Fresh machine: install nvm (needs curl or wget).
    echo "==> nvm not found; installing it into $NVM_DIR..."
    NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$NVM_INSTALL_URL" | bash
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- "$NVM_INSTALL_URL" | bash
    else
      echo "!! Neither curl nor wget is available to install nvm." >&2
      echo "   Install one (e.g. 'sudo apt install curl') or install Node >= $REQUIRED_NODE_MAJOR manually." >&2
      exit 1
    fi
  fi
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    \. "$NVM_DIR/nvm.sh"
    nvm install "$REQUIRED_NODE_MAJOR" >/dev/null
    nvm use "$REQUIRED_NODE_MAJOR" >/dev/null
    echo "==> Switched to Node $(node -v) via nvm"
  fi

  if [ "$(node_major)" -lt "$REQUIRED_NODE_MAJOR" ]; then
    echo "!! Could not get Node >= $REQUIRED_NODE_MAJOR. Install it manually" >&2
    echo "   (https://nodejs.org or https://github.com/nvm-sh/nvm), then re-run this script." >&2
    exit 1
  fi
fi

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
