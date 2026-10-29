#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
export CGO_ENABLED=0
mkdir -p build
mkdir -p release
VERSION=$(node -p 'require("./package.json").version')
ARCH=$(./scripts/go.sh env GOARCH)
case "$(uname -s)" in
  Darwin)
    APP="$ROOT/build/CC Go.app"
    mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    ./scripts/go.sh build -trimpath -ldflags='-s -w' -o "$APP/Contents/MacOS/cc-go" ./cmd/cc-go
    cp assets/icon.icns "$APP/Contents/Resources/icon.icns"
    # Remove the runtime left by older builds; use the locally installed Node.
    rm -f "$APP/Contents/Resources/node"
    cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>CC Go</string>
  <key>CFBundleDisplayName</key><string>CC Go</string>
  <key>CFBundleIdentifier</key><string>local.claude-vsix-go</string>
  <key>CFBundleExecutable</key><string>cc-go</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
    codesign --force --deep --sign - "$APP"
    printf '\nBuilt: %s\n' "$APP"
    du -sh "$APP"
    ARCHIVE="$ROOT/release/cc-go-$VERSION-darwin-$ARCH.zip"
    ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
    shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256"
    printf 'Archive: %s\n' "$ARCHIVE"
    ;;
  Linux)
    PACKAGE="cc-go-$VERSION-linux-$ARCH"
    STAGE="$ROOT/build/$PACKAGE"
    mkdir -p "$STAGE/bin" "$STAGE/share/icons/hicolor/1024x1024/apps" "$STAGE/share/applications"
    ./scripts/go.sh build -trimpath -ldflags='-s -w -X github.com/egoist/mygo.packageIdentifier=local.claude-vsix-go' -o "$STAGE/bin/cc-go" ./cmd/cc-go
    cp assets/icon.png "$STAGE/share/icons/hicolor/1024x1024/apps/cc-go.png"
    cp assets/cc-go.desktop "$STAGE/share/applications/"
    cat > "$STAGE/cc-go" <<'LAUNCHER'
#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$HERE/bin/cc-go" "$@"
LAUNCHER
    chmod +x "$STAGE/cc-go"
    cp README.md "$STAGE/README.md"
    ARCHIVE="$ROOT/release/$PACKAGE.tar.gz"
    tar -C "$ROOT/build" -czf "$ARCHIVE" "$PACKAGE"
    sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
    printf '\nBuilt: %s (requires local Node.js 22+ and GTK3/WebKitGTK 4.1)\n' "$ARCHIVE"
    ;;
  *) printf 'Unsupported build host. Use scripts/build.ps1 on Windows.\n' >&2; exit 1 ;;
esac
