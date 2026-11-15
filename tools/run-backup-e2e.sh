#!/usr/bin/env bash
# End-to-end test of the REAL MurMur backup code (iOS) on Linux/HP.
#
# WHAT IT DOES
#   Compiles the shipping files AS-IS (no copies, no edits):
#     ios/MurmurApp/BackupManager.swift       (CryptoKit AES-GCM + PBKDF2)
#     ios/MurmurApp/BackupPayloadCodec.swift  (pure payload decoding)
#     ios/MurmurApp/Models.swift              (RelayError, ChatMessage)
#   plus the harness tools/backup-e2e-test.swift,
#   with two Linux-only shims (Apple frameworks that don't exist on Linux):
#     CryptoKit    -> apple/swift-crypto (AES-GCM)
#     CommonCrypto -> OpenSSL PBKDF2 (CCKeyDerivationPBKDF)
#     Security     -> /dev/urandom (SecRandomCopyBytes)
#
#   Then it runs the FULL production path on a REAL PWA backup file:
#     file -> decrypt (PBKDF2+AES-GCM) -> decode payload
#          -> compare against tools/backup-decode-reference.js (node, independent)
#          -> export -> decrypt -> decode (round trip)
#          -> wrong password must be rejected
#
# WHY
#   The iOS app target cannot be built on HP (no Xcode). Compiling the very
#   same sources against shims proves the crypto + parsing code is correct
#   BEFORE Oleg rebuilds on the Mac — a broken backup path must not cost a
#   rebuild round-trip.
#
# USAGE
#   tools/run-backup-e2e.sh <backup.murmur> <password> [reference.json]
#
# PREREQUISITES (one-time setup on HP)
#   sudo apt-get install -y swiftlang libssl-dev
#   git clone --depth 1 --branch 3.4.0 https://github.com/apple/swift-crypto.git /tmp/swift-crypto
#   # the package below builds the shims from tools/backup-e2e/
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-/tmp/murmur-backup-e2e}"
PKG="${PKG:-/tmp/e2epkg}"
FILE="${1:?backup file required}"
PASSWORD="${2:?password required}"
REF="${3:-}"

SWIFT_CRYPTO="${SWIFT_CRYPTO:-/tmp/swift-crypto}"

if [[ ! -d "$SWIFT_CRYPTO" ]]; then
  echo "ERROR: $SWIFT_CRYPTO not found."
  echo "  git clone --depth 1 --branch 3.4.0 https://github.com/apple/swift-crypto.git $SWIFT_CRYPTO"
  exit 2
fi

echo "==> preparing the test package (shims + shipping sources)"
rm -rf "$PKG"
mkdir -p "$PKG/Sources/E2E" \
         "$PKG/Sources/CryptoKit" \
         "$PKG/Sources/CommonCrypto" \
         "$PKG/Sources/CommonCryptoShimC/include" \
         "$PKG/Sources/SecurityShimC/include"

# --- shims ---
cp "$REPO/tools/backup-e2e/CryptoKit_shim.swift"            "$PKG/Sources/CryptoKit/CryptoKit.swift"
cp "$REPO/tools/backup-e2e/CommonCrypto_Exports.swift"      "$PKG/Sources/CommonCrypto/Exports.swift"
cp "$REPO/tools/backup-e2e/CommonCrypto_Security.swift"     "$PKG/Sources/CommonCrypto/Security.swift"
cp "$REPO/tools/backup-e2e/shim_CommonCrypto.h"             "$PKG/Sources/CommonCryptoShimC/include/shim.h"
cp "$REPO/tools/backup-e2e/shim_CommonCrypto.c"             "$PKG/Sources/CommonCryptoShimC/shim.c"
cp "$REPO/tools/backup-e2e/shim_Security.h"                 "$PKG/Sources/SecurityShimC/include/security_shim.h"
cp "$REPO/tools/backup-e2e/shim_Security.c"                 "$PKG/Sources/SecurityShimC/security_shim.c"
cat > "$PKG/Sources/CommonCryptoShimC/include/module.modulemap" <<'EOF'
module CommonCryptoShimC [system] {
    header "shim.h"
    export *
}
EOF
cat > "$PKG/Sources/SecurityShimC/include/module.modulemap" <<'EOF'
module SecurityShimC [system] {
    header "security_shim.h"
    export *
}
EOF

# --- shipping sources, verbatim ---
cp "$REPO/ios/MurmurApp/BackupManager.swift"       "$PKG/Sources/E2E/"
cp "$REPO/ios/MurmurApp/BackupPayloadCodec.swift"  "$PKG/Sources/E2E/"
cp "$REPO/ios/MurmurApp/Models.swift"              "$PKG/Sources/E2E/"
cp "$REPO/tools/backup-e2e-test.swift"              "$PKG/Sources/E2E/main.swift"

cat > "$PKG/Package.swift" <<'EOF'
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "E2E",
    dependencies: [
        .package(name: "swift-crypto", path: "/tmp/swift-crypto"),
    ],
    targets: [
        .target(name: "CommonCryptoShimC", path: "Sources/CommonCryptoShimC",
                linkerSettings: [.linkedLibrary("crypto")]),
        .target(name: "SecurityShimC", path: "Sources/SecurityShimC"),
        .target(name: "CommonCrypto",
                dependencies: ["CommonCryptoShimC", "SecurityShimC"],
                path: "Sources/CommonCrypto"),
        .target(name: "CryptoKit",
                dependencies: [.product(name: "Crypto", package: "swift-crypto")],
                path: "Sources/CryptoKit"),
        .executableTarget(
            name: "e2e",
            dependencies: ["CryptoKit", "CommonCrypto"],
            path: "Sources/E2E"),
    ]
)
EOF

echo "==> building (the first run compiles BoringSSL — several minutes)"
cd "$PKG"
swift build -c release

echo "==> running the production path against $FILE"
"$PKG/.build/release/e2e" "$FILE" "$PASSWORD" "$REF"
