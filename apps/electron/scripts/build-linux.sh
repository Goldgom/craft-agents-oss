#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"

# Helper function to check required file/directory exists
require_path() {
    local path="$1"
    local description="$2"
    local hint="$3"

    if [ ! -e "$path" ]; then
        echo "ERROR: $description not found at $path"
        [ -n "$hint" ] && echo "$hint"
        exit 1
    fi
}

# Load environment variables from .env
if [ -f "$ROOT_DIR/.env" ]; then
    set -a
    source "$ROOT_DIR/.env"
    set +a
fi

# Parse arguments
ARCH="x64"
UPLOAD=false
UPLOAD_LATEST=false
UPLOAD_SCRIPT=false
FORCE_DOWNLOAD=false

show_help() {
    cat << EOF
Usage: build-linux.sh [x64|arm64] [--upload] [--latest] [--script] [--force-download]

Arguments:
  x64|arm64    Target architecture (default: x64)
  --upload     Upload AppImage to S3 after building
  --latest     Also update electron/latest (requires --upload)
  --script     Also upload install-app.sh (requires --upload)
  --force-download  Re-download build dependencies even when cached

Environment variables (from .env or environment):
  S3_VERSIONS_BUCKET_*      - S3 credentials (for --upload)
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        x64|arm64)     ARCH="$1"; shift ;;
        --upload)      UPLOAD=true; shift ;;
        --latest)      UPLOAD_LATEST=true; shift ;;
        --script)      UPLOAD_SCRIPT=true; shift ;;
        --force-download) FORCE_DOWNLOAD=true; shift ;;
        -h|--help)     show_help ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage"
            exit 1
            ;;
    esac
done

if [ "$FORCE_DOWNLOAD" = true ]; then export TOKENBIRD_FORCE_DOWNLOAD=1; else export TOKENBIRD_FORCE_DOWNLOAD=0; fi

# Configuration
BUN_VERSION="bun-v1.3.9"  # Pinned version for reproducible builds

echo "=== Building TokenBird AppImage (${ARCH}) using electron-builder ==="
if [ "$UPLOAD" = true ]; then
    echo "Will upload to S3 after build"
fi

# 1. Clean previous build artifacts
echo "Cleaning previous builds..."
rm -rf "$ELECTRON_DIR/node_modules/@anthropic-ai"
rm -rf "$ELECTRON_DIR/packages"
rm -rf "$ELECTRON_DIR/release"

# 2. Reuse installed dependencies when the lockfile and manifest match.
cd "$ROOT_DIR"
DEPENDENCY_STAMP="$ROOT_DIR/node_modules/.tokenbird-build-linux-${ARCH}.sha256"
DEPENDENCY_FINGERPRINT="$(sha256sum bun.lock package.json | sha256sum | cut -d ' ' -f1)"
DEPENDENCIES_READY=false
if [ -d node_modules/@anthropic-ai/claude-agent-sdk ] && [ -x node_modules/@vscode/ripgrep/bin/rg ] && [ -f node_modules/electron/dist/version ]; then
    DEPENDENCIES_READY=true
fi
if [ "$FORCE_DOWNLOAD" = true ] || [ "$DEPENDENCIES_READY" = false ] || [ ! -f "$DEPENDENCY_STAMP" ] || [ "$(cat "$DEPENDENCY_STAMP")" != "$DEPENDENCY_FINGERPRINT" ]; then
    echo "Installing dependencies..."
    if [ "$FORCE_DOWNLOAD" = true ]; then bun install --frozen-lockfile --force; else bun install --frozen-lockfile; fi
    if [ ! -x node_modules/@vscode/ripgrep/bin/rg ]; then bun pm trust @vscode/ripgrep; fi
else
    echo "Reusing installed dependencies from node_modules"
fi
printf '%s' "$DEPENDENCY_FINGERPRINT" > "$DEPENDENCY_STAMP"

# 3. Download Bun binary with checksum verification
mkdir -p "$ELECTRON_DIR/vendor/bun"

# Map architecture names (electron uses x64/arm64, bun uses x64/aarch64)
if [ "$ARCH" = "arm64" ]; then
    BUN_DOWNLOAD="bun-linux-aarch64"
else
    BUN_DOWNLOAD="bun-linux-x64-baseline"
fi

BUN_PATH="$ELECTRON_DIR/vendor/bun/bun"
BUN_CACHE_STAMP="$ELECTRON_DIR/vendor/bun/.build-runtime"
BUN_CACHED=false
if [ "$FORCE_DOWNLOAD" = false ] && [ -f "$BUN_PATH" ]; then
    if [ -f "$BUN_CACHE_STAMP" ] && [ "$(cat "$BUN_CACHE_STAMP")" = "${BUN_VERSION}:${BUN_DOWNLOAD}" ]; then
        BUN_CACHED=true
    elif { [ "$ARCH" = x64 ] && [ "$(uname -m)" = x86_64 ]; } || { [ "$ARCH" = arm64 ] && [ "$(uname -m)" = aarch64 ]; }; then
        if [ "$("$BUN_PATH" --version 2>/dev/null || true)" = "${BUN_VERSION#bun-v}" ]; then BUN_CACHED=true; fi
    fi
fi

if [ "$BUN_CACHED" = true ]; then
    echo "Reusing Bun ${BUN_VERSION} at $BUN_PATH"
    printf '%s' "${BUN_VERSION}:${BUN_DOWNLOAD}" > "$BUN_CACHE_STAMP"
else
echo "Downloading Bun ${BUN_VERSION} for linux-${ARCH}..."
# Create temp directory to avoid race conditions
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Download binary and checksums
curl -fSL "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/${BUN_DOWNLOAD}.zip" -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip"
curl -fSL "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"

# Verify checksum
echo "Verifying checksum..."
cd "$TEMP_DIR"
# Use sha256sum on Linux (not shasum)
grep "${BUN_DOWNLOAD}.zip" SHASUMS256.txt | sha256sum -c -
cd - > /dev/null

# Extract and install
unzip -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip" -d "$TEMP_DIR"
cp "$TEMP_DIR/${BUN_DOWNLOAD}/bun" "$ELECTRON_DIR/vendor/bun/"
chmod +x "$ELECTRON_DIR/vendor/bun/bun"
printf '%s' "${BUN_VERSION}:${BUN_DOWNLOAD}" > "$BUN_CACHE_STAMP"
fi

# 4. Copy SDK from root node_modules (monorepo hoisting).
# Since SDK 0.2.113: thin core + per-platform binary package.
# See apps/electron/scripts/build-dmg.sh for the full rationale.
SDK_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
require_path "$SDK_SOURCE" "SDK core" "Run 'bun install' from the repository root first."
echo "Copying SDK core..."
mkdir -p "$ELECTRON_DIR/node_modules/@anthropic-ai"
rm -rf "$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
cp -r "$SDK_SOURCE" "$ELECTRON_DIR/node_modules/@anthropic-ai/"

# 4a. Resolve the target arch's binary package (cross-fetch from npm if absent).
SDK_BIN_PKG="claude-agent-sdk-linux-${ARCH}"
SDK_BIN_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/${SDK_BIN_PKG}"
if [ "$FORCE_DOWNLOAD" = true ] || [ ! -d "$SDK_BIN_SOURCE" ]; then
    SDK_VERSION=$(node -p "require('$ROOT_DIR/package.json').dependencies['@anthropic-ai/claude-agent-sdk']" | tr -d '"')
    CACHE_DIR="$ROOT_DIR/.build/native-packages"
    TARBALL="$CACHE_DIR/anthropic-ai-${SDK_BIN_PKG}-${SDK_VERSION}.tgz"
    mkdir -p "$CACHE_DIR"
    if [ "$FORCE_DOWNLOAD" = true ] || [ ! -f "$TARBALL" ]; then
        echo "Fetching ${SDK_BIN_PKG}@${SDK_VERSION} from npm..."
        if [ "$FORCE_DOWNLOAD" = true ]; then
            npm pack "@anthropic-ai/${SDK_BIN_PKG}@${SDK_VERSION}" --force --prefer-online --pack-destination "$CACHE_DIR" >/dev/null
        else
            npm pack "@anthropic-ai/${SDK_BIN_PKG}@${SDK_VERSION}" --pack-destination "$CACHE_DIR" >/dev/null
        fi
    else
        echo "Reusing cached ${SDK_BIN_PKG}@${SDK_VERSION}"
    fi
    PKG_TMP=$(mktemp -d)
    tar -xzf "$TARBALL" -C "$PKG_TMP"
    rm -rf "$SDK_BIN_SOURCE"
    mkdir -p "$SDK_BIN_SOURCE"
    cp -r "$PKG_TMP/package/." "$SDK_BIN_SOURCE/"
    rm -rf "$PKG_TMP"
fi

require_path "$SDK_BIN_SOURCE" "SDK native binary package (${SDK_BIN_PKG})" \
  "Run 'bun install' from the repository root, or check your network for the npm cross-fetch."

echo "Staging SDK native binary as claude-agent-sdk-binary alias..."
ALIAS_DEST="$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk-binary"
rm -rf "$ALIAS_DEST"
mkdir -p "$ALIAS_DEST"
cp -r "$SDK_BIN_SOURCE/." "$ALIAS_DEST/"
chmod +x "$ALIAS_DEST/claude"

BIN_SIZE=$(stat -c%s "$ALIAS_DEST/claude")
if [ "$BIN_SIZE" -lt 50000000 ]; then
    echo "ERROR: claude binary at $ALIAS_DEST/claude is only ${BIN_SIZE} bytes (expected ~210 MB)"
    exit 1
fi
echo "  Native binary: $((BIN_SIZE / 1024 / 1024)) MB"

# 5. Copy ripgrep (sourced from @vscode/ripgrep since 0.2.113).
RG_SOURCE="$ROOT_DIR/node_modules/@vscode/ripgrep"
require_path "$RG_SOURCE" "@vscode/ripgrep" "Run 'bun install' and 'bun pm trust @vscode/ripgrep' first."
require_path "$RG_SOURCE/bin/rg" "ripgrep binary" "@vscode/ripgrep postinstall did not run."
echo "Copying @vscode/ripgrep..."
mkdir -p "$ELECTRON_DIR/node_modules/@vscode"
rm -rf "$ELECTRON_DIR/node_modules/@vscode/ripgrep"
cp -r "$RG_SOURCE" "$ELECTRON_DIR/node_modules/@vscode/"

# 6. Copy network interceptor sources (for Pi subprocess; Claude no longer
#    uses --preload — Phase 2 will move that to SDK hooks or a local proxy).
INTERCEPTOR_SOURCE="$ROOT_DIR/packages/shared/src/unified-network-interceptor.ts"
require_path "$INTERCEPTOR_SOURCE" "Interceptor" "Ensure packages/shared/src/unified-network-interceptor.ts exists."
echo "Copying interceptor (for Pi subprocess)..."
mkdir -p "$ELECTRON_DIR/packages/shared/src"
cp "$INTERCEPTOR_SOURCE" "$ELECTRON_DIR/packages/shared/src/"
for dep in interceptor-common.ts feature-flags.ts interceptor-request-utils.ts network-diagnostics.ts; do
  if [ -f "$ROOT_DIR/packages/shared/src/$dep" ]; then
    cp "$ROOT_DIR/packages/shared/src/$dep" "$ELECTRON_DIR/packages/shared/src/"
  fi
done

# 6. Build Electron app
echo "Building Electron app..."
cd "$ROOT_DIR"
bun run electron:build

# 7. Package with electron-builder
echo "Packaging app with electron-builder..."
cd "$ELECTRON_DIR"

# Reuse the Electron binary installed by bun install for a native build.
# This avoids downloading the same archive a second time, which can produce
# a corrupt ZIP when a proxy interrupts electron-builder's range requests.
ELECTRON_DIST="$ROOT_DIR/node_modules/electron/dist"
HOST_ARCH="$(uname -m)"
if [ "$FORCE_DOWNLOAD" = false ] && [ -f "$ELECTRON_DIST/version" ] && {
    { [ "$ARCH" = "x64" ] && [ "$HOST_ARCH" = "x86_64" ]; } ||
    { [ "$ARCH" = "arm64" ] && [ "$HOST_ARCH" = "aarch64" ]; }
}; then
    npx electron-builder --linux --${ARCH} --publish never --config.electronDist="$ELECTRON_DIST"
else
    npx electron-builder --linux --${ARCH} --publish never
fi

# 8. Verify the AppImage was built
# electron-builder uses Linux-style arch names: x86_64 for x64, aarch64 for arm64
if [ "$ARCH" = "x64" ]; then
    LINUX_ARCH="x86_64"
else
    LINUX_ARCH="aarch64"
fi

# electron-builder outputs: TokenBird-x86_64.AppImage or TokenBird-aarch64.AppImage
BUILT_APPIMAGE_NAME="TokenBird-${ARCH}.AppImage"
BUILT_APPIMAGE_PATH="$ELECTRON_DIR/release/$BUILT_APPIMAGE_NAME"

# Older builder versions use Linux architecture names in artifactName.
if [ ! -f "$BUILT_APPIMAGE_PATH" ]; then
    BUILT_APPIMAGE_NAME="TokenBird-${LINUX_ARCH}.AppImage"
    BUILT_APPIMAGE_PATH="$ELECTRON_DIR/release/$BUILT_APPIMAGE_NAME"
fi

if [ ! -f "$BUILT_APPIMAGE_PATH" ]; then
    echo "ERROR: Expected AppImage not found at $BUILT_APPIMAGE_PATH"
    echo "Contents of release directory:"
    ls -la "$ELECTRON_DIR/release/"
    exit 1
fi

# Rename to our standard naming convention: TokenBird-x64.AppImage, TokenBird-arm64.AppImage
APPIMAGE_NAME="TokenBird-${ARCH}.AppImage"
APPIMAGE_PATH="$ELECTRON_DIR/release/$APPIMAGE_NAME"
if [ "$BUILT_APPIMAGE_NAME" != "$APPIMAGE_NAME" ]; then
    mv "$BUILT_APPIMAGE_PATH" "$APPIMAGE_PATH"
    if [ -f "${BUILT_APPIMAGE_PATH}.blockmap" ]; then
        mv "${BUILT_APPIMAGE_PATH}.blockmap" "${APPIMAGE_PATH}.blockmap"
    fi
    # Keep electron-updater paths consistent with the renamed package.
    if [ -f "$ELECTRON_DIR/release/latest-linux.yml" ]; then
        sed "s/${BUILT_APPIMAGE_NAME}/${APPIMAGE_NAME}/g" "$ELECTRON_DIR/release/latest-linux.yml" > "$ELECTRON_DIR/release/latest-linux.yml.tmp"
        mv "$ELECTRON_DIR/release/latest-linux.yml.tmp" "$ELECTRON_DIR/release/latest-linux.yml"
    fi
    echo "Renamed $BUILT_APPIMAGE_NAME -> $APPIMAGE_NAME"
fi

echo ""
echo "=== Build Complete ==="
echo "AppImage: $ELECTRON_DIR/release/${APPIMAGE_NAME}"
echo "Size: $(du -h "$ELECTRON_DIR/release/${APPIMAGE_NAME}" | cut -f1)"

# 9. Create manifest.json for upload script
# Read version from package.json
ELECTRON_VERSION=$(cat "$ELECTRON_DIR/package.json" | grep '"version"' | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
echo "Creating manifest.json (version: $ELECTRON_VERSION)..."
mkdir -p "$ROOT_DIR/.build/upload"
echo "{\"version\": \"$ELECTRON_VERSION\"}" > "$ROOT_DIR/.build/upload/manifest.json"

# 10. Upload to S3 (if --upload flag is set)
if [ "$UPLOAD" = true ]; then
    echo ""
    echo "=== Uploading to S3 ==="

    # Check for S3 credentials
    if [ -z "$S3_VERSIONS_BUCKET_ENDPOINT" ] || [ -z "$S3_VERSIONS_BUCKET_ACCESS_KEY_ID" ] || [ -z "$S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY" ]; then
        cat << EOF
ERROR: Missing S3 credentials. Set these environment variables:
  S3_VERSIONS_BUCKET_ENDPOINT
  S3_VERSIONS_BUCKET_ACCESS_KEY_ID
  S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY

You can add them to .env or export them directly.
EOF
        exit 1
    fi

    # Build upload flags
    UPLOAD_FLAGS="--electron"
    [ "$UPLOAD_LATEST" = true ] && UPLOAD_FLAGS="$UPLOAD_FLAGS --latest"
    [ "$UPLOAD_SCRIPT" = true ] && UPLOAD_FLAGS="$UPLOAD_FLAGS --script"

    cd "$ROOT_DIR"
    bun run scripts/upload.ts $UPLOAD_FLAGS

    echo ""
    echo "=== Upload Complete ==="
fi
