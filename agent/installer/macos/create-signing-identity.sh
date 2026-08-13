#!/usr/bin/env bash
# Create the ONE self-signed code-signing identity used for every NU Agent build.
#
# Why this exists: macOS ties TCC grants (Full Disk Access, Accessibility, Screen
# Recording) to the code-signing identity, not the file path. Ad-hoc signing —
# what you get by default from a local `go build` — mints a fresh identity on
# every build, so macOS treats each self-update as brand-new software and drops
# every permission the customer granted. Remote control then silently stops
# working until somebody re-approves three dialogs on their machine.
#
# A stable self-signed identity fixes that. It does NOT make us Apple-notarised:
# the customer still sees "unidentified developer" on first install and chooses to
# proceed. That tradeoff is deliberate and agreed.
#
# Run ONCE. Then back up the exported .p12 somewhere safe and out of the repo — if
# this key is lost, every deployed agent loses its permissions on the next update.
set -euo pipefail

CN="${CN:-NU Agent Signing}"
OUT_DIR="${OUT_DIR:-$HOME/.nu-agent-signing}"
DAYS="${DAYS:-3650}"

if security find-certificate -c "$CN" >/dev/null 2>&1; then
  echo "identity '$CN' already exists in the login keychain — reusing it."
  echo "codesign with:  --sign \"$CN\""
  exit 0
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
cd "$OUT_DIR"

echo "==> generating key + self-signed code-signing certificate"
cat > openssl.cnf <<EOF
[ req ]
distinguished_name = dn
prompt             = no
x509_extensions    = v3

[ dn ]
CN = $CN
O  = Nodes Unlimited
C  = US

[ v3 ]
basicConstraints       = critical,CA:false
keyUsage               = critical,digitalSignature
extendedKeyUsage       = critical,codeSigning
subjectKeyIdentifier   = hash
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
  -keyout nu-signing.key -out nu-signing.crt -config openssl.cnf

openssl pkcs12 -export -inkey nu-signing.key -in nu-signing.crt \
  -name "$CN" -out nu-signing.p12 -passout pass:

chmod 600 nu-signing.key nu-signing.p12

echo "==> importing into the login keychain"
security import nu-signing.p12 -k "$HOME/Library/Keychains/login.keychain-db" \
  -P "" -T /usr/bin/codesign -T /usr/bin/productsign

# Trust it for code signing so codesign will use it without prompting.
echo "==> marking the certificate as trusted (may prompt for your login password)"
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain nu-signing.crt || {
    echo "note: trust step skipped. codesign still works; Gatekeeper will still warn."
  }

echo
echo "identity ready: $CN"
echo "backup this file somewhere safe and OUT of the repo:"
echo "  $OUT_DIR/nu-signing.p12"
echo
echo "build signed packages with:"
echo "  SIGN_IDENTITY=\"$CN\" ./installer/macos/build-pkg.sh arm64"
