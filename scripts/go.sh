#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -x "$ROOT/.tools/go/bin/go" ]; then
  exec "$ROOT/.tools/go/bin/go" "$@"
fi
exec go "$@"
