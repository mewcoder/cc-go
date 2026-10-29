#!/bin/sh
set -eu
# Compatibility entry point only. All packaging logic lives in Node.
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Packaging requires Node.js 22 or newer on PATH.' >&2
  exit 127
fi
SCRIPT_DIR=${0%/*}
if [ "$SCRIPT_DIR" = "$0" ]; then SCRIPT_DIR=.; fi
exec node "$SCRIPT_DIR/build.cjs" "$@"
