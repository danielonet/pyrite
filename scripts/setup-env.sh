#!/usr/bin/env bash
# Sets up a fresh Debian/Ubuntu machine for building Pyrite: installs Node.js
# and npm via apt, then runs `npm install` in the repo.
#
# Usage:
#   scripts/setup-env.sh
#
# Afterwards, run scripts/build-and-install.sh to build and install the extension.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REQUIRED_NODE_MAJOR=20
node_major() {
  if command -v node >/dev/null 2>&1; then
    node -e 'console.log(process.versions.node.split(".")[0])'
  else
    echo 0
  fi
}

if ! command -v apt-get >/dev/null 2>&1; then
  echo "!! apt-get not found; this script only supports Debian/Ubuntu." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

# 1. Install Node.js and npm via apt.
if [ "$(node_major)" -lt "$REQUIRED_NODE_MAJOR" ] || ! command -v npm >/dev/null 2>&1; then
  echo "==> Installing nodejs and npm via apt..."
  $SUDO apt-get update
  $SUDO apt-get install -y curl ca-certificates nodejs npm
fi

# 2. The distro's Node can be older than @vscode/vsce needs. If so, add the
#    NodeSource apt repository for Node $REQUIRED_NODE_MAJOR and upgrade.
if [ "$(node_major)" -lt "$REQUIRED_NODE_MAJOR" ]; then
  echo "==> apt provided Node $(node -v); adding NodeSource repo for Node $REQUIRED_NODE_MAJOR.x..."
  curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

if [ "$(node_major)" -lt "$REQUIRED_NODE_MAJOR" ]; then
  echo "!! Still on Node $(node -v); need >= $REQUIRED_NODE_MAJOR." >&2
  exit 1
fi

echo "==> Node $(node -v), npm $(npm -v)"

# 3. Install project dependencies.
echo "==> Running npm install..."
npm install

echo
echo "Done. Run scripts/build-and-install.sh to build and install the extension."
