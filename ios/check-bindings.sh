#!/usr/bin/env bash
# Regression guard: UniFFI metadata must actually produce Swift bindings.
#
# Why this exists: murmur-uniffi's Rust tests passed 10/10 while Swift binding
# generation was silently broken (constructor returned a wrapper type instead of
# Arc<Self>). Rust tests never cross the UniFFI metadata layer, so only a real
# bindgen run catches ABI/shape errors. Run this before any iOS release build.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> building murmur-uniffi (host cdylib)"
cargo build -p murmur-uniffi --quiet

LIB="target/debug/libmurmur_uniffi.so"
[[ -f "$LIB" ]] || LIB="target/debug/libmurmur_uniffi.dylib"
[[ -f "$LIB" ]] || { echo "FAIL: no host cdylib produced"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> running uniffi-bindgen (swift)"
BINDGEN_OUT="$(cargo run -p murmur-uniffi --quiet --bin uniffi-bindgen -- \
  generate --library "$LIB" --language swift --out-dir "$TMP" 2>&1 || true)"
if echo "$BINDGEN_OUT" | grep -qi 'error'; then
  echo "FAIL: bindgen reported an error:"
  echo "$BINDGEN_OUT"
  exit 1
fi

SWIFT_FILE="$(find "$TMP" -name '*.swift' | head -1)"
if [[ -z "$SWIFT_FILE" ]]; then
  echo "FAIL: bindgen produced no .swift file (silent metadata failure)"
  echo "$BINDGEN_OUT"
  exit 1
fi

echo "==> checking critical API surface"
missing=0
for sym in \
  'class MurmurIdentity' \
  'static func generate' \
  'restoreHex' \
  'func eciesEncrypt' \
  'func eciesDecrypt' \
  'func exportSkHex' \
  'func murmurBackupParse' \
  'struct BackupIdentity'
do
  if ! grep -q "$sym" "$SWIFT_FILE"; then
    echo "FAIL: missing from generated Swift: $sym"
    missing=1
  fi
done
[[ $missing -eq 0 ]] || exit 1

echo "OK: $(basename "$SWIFT_FILE"), $(wc -l < "$SWIFT_FILE") lines, all expected symbols present"
