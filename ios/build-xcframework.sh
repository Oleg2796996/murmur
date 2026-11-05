#!/usr/bin/env bash
# Build murmur_uniffi XCFramework for iOS (run on macOS with Xcode toolchain).
#
# Usage:  ./ios/build-xcframework.sh
# Output: ios/MurmurKit/MurmurUniffi.xcframework
#
# Requires:
#   rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
#   cargo install uniffi-bindgen  (or use the workspace bin: cargo run -p murmur-uniffi --bin uniffi-bindgen --)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/ios/MurmurKit"

echo "==> adding rust targets (idempotent)"
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

echo "==> building device slice (aarch64-apple-ios)"
cargo build -p murmur-uniffi --release --target aarch64-apple-ios

echo "==> building simulator slices"
cargo build -p murmur-uniffi --release --target aarch64-apple-ios-sim
cargo build -p murmur-uniffi --release --target x86_64-apple-ios

DEVICE_LIB="$ROOT/target/aarch64-apple-ios/release/libmurmur_uniffi.a"
SIM_ARM_LIB="$ROOT/target/aarch64-apple-ios-sim/release/libmurmur_uniffi.a"
SIM_X86_LIB="$ROOT/target/x86_64-apple-ios/release/libmurmur_uniffi.a"

for f in "$DEVICE_LIB" "$SIM_ARM_LIB" "$SIM_X86_LIB"; do
  [[ -f "$f" ]] || { echo "missing $f"; exit 1; }
done

echo "==> merging simulator slices (arm64 + x86_64 -> fat)"
SIM_FAT="$(mktemp -d)/libmurmur_uniffi_sim.a"
lipo -create "$SIM_ARM_LIB" "$SIM_X86_LIB" -output "$SIM_FAT"

echo "==> generating Swift bindings from the device staticlib"
cargo run -p murmur-uniffi --bin uniffi-bindgen -- \
  generate --library "$DEVICE_LIB" --language swift --out-dir "$OUT/Generated"

cp "$OUT/Generated/murmur_uniffiFFI.modulemap" "$OUT/Generated/module.modulemap"

echo "==> packaging XCFramework"
rm -rf "$OUT/MurmurUniffi.xcframework"
xcodebuild -create-xcframework \
  -library "$DEVICE_LIB" -headers "$OUT/Generated" \
  -library "$SIM_FAT"    -headers "$OUT/Generated" \
  -output "$OUT/MurmurUniffi.xcframework"

echo "==> done: $OUT/MurmurUniffi.xcframework"
echo "    In Xcode: add the xcframework + Generated/murmur_uniffi.swift to the app target."
