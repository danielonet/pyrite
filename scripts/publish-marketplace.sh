#!/usr/bin/env bash
# Builds the Pyrite extension into a .vsix and publishes it to the Visual
# Studio Marketplace (https://marketplace.visualstudio.com).
#
# Usage:
#   scripts/publish-marketplace.sh [patch|minor|major|<version>] [options]
#
# Positional argument (optional):
#   patch|minor|major   Bump package.json's version accordingly before publishing.
#   <version>           Set package.json's version to this exact semver before publishing.
#   (omitted)           Publish whatever version is already in package.json, unchanged.
#
# A bump/version is applied via `vsce publish`, which runs `npm version` under the
# hood: it updates package.json, and (in a real, non-dry-run publish) commits and tags
# that change locally as "vX.Y.Z" - see "Done" output for the exact push command.
#
# Options:
#   --dry-run       Build and package only; do not publish, bump, commit or tag.
#   -y, --yes       Skip the confirmation prompt before publishing.
#   --skip-tests    Skip "npm test" before packaging.
#   --env-file PATH Read credentials from PATH instead of the default location.
#   -h, --help      Show this help.
#
# Safety checks
# -------------
# Before an actual (non-dry-run) publish, the script requires a clean git working
# tree (no uncommitted changes) so the published package - and any version bump's
# commit/tag - correspond to real, committed history.
#
# Credentials
# -----------
# The publisher id and the Marketplace personal access token (PAT) are never
# kept in this repository. They are read from a plain text file OUTSIDE the
# repo, by default:
#
#   ~/.config/pyrite/marketplace.env
#
# (override with --env-file, or the PYRITE_MARKETPLACE_ENV_FILE environment
# variable). If that file does not exist yet, this script creates a template
# there (permissions 600) and stops so you can fill it in. Its contents:
#
#   VSCE_PAT=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
#   # Optional - defaults to the "publisher" field in package.json.
#   VSCE_PUBLISHER=danielonnet
#
# Get a PAT from https://dev.azure.com -> User settings -> Personal access
# tokens, scoped to "Marketplace (Manage)", for the org that owns the
# "danielonnet" publisher (see https://marketplace.visualstudio.com/manage).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DRY_RUN=0
ASSUME_YES=0
SKIP_TESTS=0
BUMP=""
ENV_FILE="${PYRITE_MARKETPLACE_ENV_FILE:-$HOME/.config/pyrite/marketplace.env}"
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

print_usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --env-file)
      shift
      ENV_FILE="${1:-}"
      [ -n "$ENV_FILE" ] || { echo "!! --env-file requires a path" >&2; exit 2; }
      ;;
    -h|--help) print_usage; exit 0 ;;
    patch|minor|major)
      [ -z "$BUMP" ] || { echo "!! Only one version bump / version may be given" >&2; exit 2; }
      BUMP="$1"
      ;;
    -*) echo "Unknown option: $1" >&2; print_usage; exit 2 ;;
    *)
      if [[ "$1" =~ $SEMVER_RE ]]; then
        [ -z "$BUMP" ] || { echo "!! Only one version bump / version may be given" >&2; exit 2; }
        BUMP="$1"
      else
        echo "!! Not a valid bump keyword (patch|minor|major) or semver: $1" >&2
        print_usage
        exit 2
      fi
      ;;
  esac
  shift
done

echo "==> Working in $ROOT_DIR"

# 1. Require a clean git working tree before any real (non-dry-run) publish, so the
#    published package - and any version bump's commit/tag - correspond to a real commit.
if [ "$DRY_RUN" -ne 1 ]; then
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "!! Not inside a git repository." >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "!! Working tree has uncommitted changes. Commit or stash them first (or use --dry-run):" >&2
    git status --short >&2
    exit 1
  fi
fi

# 2. Credentials: a plain text file outside the repo, never committed.
if [ ! -f "$ENV_FILE" ]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  umask 077
  cat > "$ENV_FILE" <<'EOF'
# Visual Studio Marketplace publishing credentials for Pyrite.
# This file is NOT part of the git repository - keep it out of any repo,
# and do not share it. Permissions are already restricted to your user (600).

VSCE_PAT=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional - defaults to the "publisher" field in package.json.
# VSCE_PUBLISHER=danielonnet
EOF
  chmod 600 "$ENV_FILE"
  echo "!! No credentials found. Created a template at: $ENV_FILE"
  echo "   Edit it with your real Marketplace PAT (and optionally VSCE_PUBLISHER), then re-run this script."
  exit 1
fi

# Reject group/world-readable credential files rather than silently using them.
FILE_PERMS="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo '')"
if [ -n "$FILE_PERMS" ] && [ "${FILE_PERMS: -2}" != "00" ]; then
  echo "!! $ENV_FILE is readable by others (mode $FILE_PERMS). Run: chmod 600 \"$ENV_FILE\"" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

if [ -z "${VSCE_PAT:-}" ] || [ "$VSCE_PAT" = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" ]; then
  echo "!! VSCE_PAT is not set in $ENV_FILE. Add your Marketplace personal access token there." >&2
  exit 1
fi

PUBLISHER="${VSCE_PUBLISHER:-$(node -p "require('./package.json').publisher")}"
VERSION="$(node -p "require('./package.json').version")"
EXT_NAME="$(node -p "require('./package.json').name")"

# 3. @vscode/vsce (and its dependencies, e.g. @azure/identity) require
#    Node >= 20. If the shell that invoked this script resolved an older
#    system Node, try to pick up nvm and switch before it gets used below.
REQUIRED_NODE_MAJOR=20
node_major() { node -e 'console.log(process.versions.node.split(".")[0])'; }

if [ "$(node_major)" -lt "$REQUIRED_NODE_MAJOR" ]; then
  echo "==> Node $(node -v) is too old for @vscode/vsce (needs >= $REQUIRED_NODE_MAJOR); looking for nvm..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    \. "$NVM_DIR/nvm.sh"
    if [ -f "$ROOT_DIR/.nvmrc" ]; then
      nvm install >/dev/null
      nvm use >/dev/null
    else
      nvm install "$REQUIRED_NODE_MAJOR" >/dev/null
      nvm use "$REQUIRED_NODE_MAJOR" >/dev/null
    fi
    echo "==> Switched to Node $(node -v) via nvm"
  fi

  if [ "$(node_major)" -lt "$REQUIRED_NODE_MAJOR" ]; then
    echo "!! Still on Node $(node -v). Install nvm (https://github.com/nvm-sh/nvm)" >&2
    echo "   and run: nvm install $REQUIRED_NODE_MAJOR" >&2
    echo "   then re-run this script." >&2
    exit 1
  fi
fi

# 4. Install dependencies if needed.
if [ ! -d node_modules ]; then
  echo "==> Installing npm dependencies..."
  npm install
fi

# 5. Compile + test before packaging anything that might get published.
echo "==> Compiling..."
npm run compile

if [ "$SKIP_TESTS" -eq 1 ]; then
  echo "==> Skipping tests (--skip-tests)."
else
  echo "==> Running tests..."
  npm test
fi

# 6. Package the extension into a .vsix using @vscode/vsce. This is a pre-flight check
#    (does the current tree actually build and package?) even when --bump is given: that
#    package publishes the OLD version below, since vsce rebuilds at the bumped version.
echo "==> Packaging extension..."
VSIX_PATH="$ROOT_DIR/pyrite.vsix"
npx --yes @vscode/vsce package --out "$VSIX_PATH"
echo "==> Packaged $VSIX_PATH"

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  if [ -n "$BUMP" ]; then
    echo "Dry run: not bumping the version, committing, tagging, or publishing."
    echo "Package built at the current version ($VERSION) is at $VSIX_PATH"
  else
    echo "Dry run: not publishing. Package is at $VSIX_PATH"
  fi
  exit 0
fi

# 7. Confirm, then publish.
echo
echo "About to publish:"
echo "  Extension: $EXT_NAME"
echo "  Publisher: $PUBLISHER"
if [ -n "$BUMP" ]; then
  echo "  Version:   $VERSION -> bumped by '$BUMP' (npm version will commit + tag locally, not pushed)"
else
  echo "  Version:   $VERSION"
  echo "  Package:   $VSIX_PATH"
fi
echo "  Target:    https://marketplace.visualstudio.com/items?itemName=$PUBLISHER.$EXT_NAME"
echo

if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Publish this version to the Marketplace? [y/N] " REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

if [ -n "$BUMP" ]; then
  echo "==> Bumping version ($BUMP), then packaging and publishing with vsce..."
  npx --yes @vscode/vsce publish "$BUMP" --pat "$VSCE_PAT" -m "Release v%s"
  VERSION="$(node -p "require('./package.json').version")"
else
  echo "==> Publishing with vsce..."
  npx --yes @vscode/vsce publish --packagePath "$VSIX_PATH" --pat "$VSCE_PAT"
fi

echo
echo "Done. Published $EXT_NAME v$VERSION as $PUBLISHER."
echo "  https://marketplace.visualstudio.com/items?itemName=$PUBLISHER.$EXT_NAME"
echo
if [ -n "$BUMP" ]; then
  echo "vsce committed and tagged v$VERSION locally (via npm version). Push them:"
  echo "  git push && git push origin v$VERSION"
else
  echo "Consider tagging the release: git tag v$VERSION && git push --tags"
fi
