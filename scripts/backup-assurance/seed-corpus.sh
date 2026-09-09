#!/usr/bin/env bash
# Seed the backup-assurance fidelity corpus (Linux / macOS).
#
#   seed-corpus.sh <root> [--big] [--many N]
#
# Deterministic content (AES-CTR keystream from a fixed passphrase) so two rigs
# seeded the same way hash identically. See docs/testing/backup-assurance/ §4.1.
set -euo pipefail

ROOT=${1:?usage: seed-corpus.sh <root> [--big] [--many N]}
shift || true
BIG=0
MANY=10000
while [ $# -gt 0 ]; do
  case "$1" in
    --big) BIG=1 ;;
    --many) MANY=$2; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done

# Deterministic pseudo-random bytes: $1 = byte count, $2 = per-file seed.
prand() {
  local n=$1 seed=$2
  if [ "$n" -eq 0 ]; then return; fi
  head -c "$n" /dev/zero | openssl enc -aes-256-ctr -nosalt -pass "pass:breeze-assurance-$seed" -pbkdf2 2>/dev/null | head -c "$n"
}

mkdir -p "$ROOT"
cd "$ROOT"
rm -rf sizes names content meta many adversarial empty

# --- sizes -----------------------------------------------------------------
mkdir -p sizes
: > sizes/0B.bin
prand 1 s1 > sizes/1B.bin
prand 4095 s4095 > sizes/4095B.bin
prand 4096 s4096 > sizes/4096B.bin
prand $((1024*1024)) s1m > sizes/1MiB.bin
prand $((100*1024*1024)) s100m > sizes/100MiB.bin
if [ "$BIG" = 1 ]; then
  # 2.5 GiB forces S3 multipart; generated in 100 MiB chunks to keep openssl bounded.
  : > sizes/2.5GiB.bin
  for i in $(seq 1 25); do prand $((100*1024*1024)) "big$i" >> sizes/2.5GiB.bin; done
  prand $((512*1024*1024)) bigtail >> sizes/2.5GiB.bin
fi

# --- names -----------------------------------------------------------------
mkdir -p "names/café" "names/日本語" "names/emoji 🚀" "names/spaces in name" names/dots names/special
prand 2048 n1 > "names/café/naïve résumé.txt"
prand 2048 n2 > "names/日本語/ファイル.txt"
prand 2048 n3 > "names/emoji 🚀/rocket 🎉.bin"
prand 2048 n4 > "names/spaces in name/ leading and trailing .txt"
prand 2048 n5 > "names/dots/.hidden"
prand 2048 n6 > "names/dots/trailing."
prand 2048 n7 > "names/dots/..double-dot-prefix"
prand 2048 n8 > 'names/special/#hash %percent +plus &amp ;semi ,comma.txt'
prand 2048 n9 > "names/special/quote'apos\"dq.txt"
prand 2048 n10 > 'names/special/back\slash.txt'
prand 2048 n11 > 'names/special/question?star*.txt' 2>/dev/null || true
LONG=$(printf 'L%.0s' $(seq 1 200))
mkdir -p "names/$LONG"
prand 2048 n12 > "names/$LONG/$LONG.txt"
DEEP=names/deep
for i in $(seq 1 20); do DEEP="$DEEP/level$i"; done
mkdir -p "$DEEP"
prand 2048 n13 > "$DEEP/bottom.txt"

# --- content ---------------------------------------------------------------
mkdir -p content
prand 65536 c1 > content/random.bin
head -c 1048576 /dev/zero > content/zeros-1MiB.bin
{ yes 'the quick brown fox jumps over the lazy dog' 2>/dev/null || true; } | head -c 1048576 > content/compressible-1MiB.txt
printf '\x00\x01\x02\x7f\x80\xff' > content/edge-bytes.bin
python3 - <<'PY' 2>/dev/null || perl -e 'print map { chr($_) } 0..255' > content/all-bytes.bin
open('content/all-bytes.bin','wb').write(bytes(range(256)))
PY
# sparse: 64 MiB apparent, ~0 allocated
truncate -s 64M content/sparse-64MiB.bin 2>/dev/null || dd if=/dev/zero of=content/sparse-64MiB.bin bs=1 count=0 seek=67108864 2>/dev/null
printf 'tail' | dd of=content/sparse-64MiB.bin bs=1 seek=67108860 conv=notrunc 2>/dev/null
cp content/random.bin content/random-duplicate.bin
printf 'CRLF line 1\r\nCRLF line 2\r\n' > content/crlf.txt
printf 'no trailing newline' > content/no-newline.txt

# --- metadata ----------------------------------------------------------------
mkdir -p meta/links meta/hardlink
prand 1024 m1 > meta/mode-0600.txt; chmod 0600 meta/mode-0600.txt
prand 1024 m2 > meta/mode-0755.sh;  chmod 0755 meta/mode-0755.sh
prand 1024 m3 > meta/mode-0444.txt; chmod 0444 meta/mode-0444.txt
prand 1024 m4 > meta/setuid.bin;    chmod 4755 meta/setuid.bin
prand 1024 m5 > meta/old-mtime.txt
touch -t 202001020304.05 meta/old-mtime.txt
prand 1024 m6 > meta/hardlink/a.txt
ln meta/hardlink/a.txt meta/hardlink/b.txt
ln -s ../../sizes/1MiB.bin meta/links/sym-to-file
ln -s ../../content meta/links/sym-to-dir
ln -s /nonexistent/target meta/links/sym-dangling
if command -v xattr >/dev/null 2>&1; then
  prand 1024 m7 > meta/xattr.txt
  xattr -w com.breeze.assurance 'xattr-value-1' meta/xattr.txt 2>/dev/null || true
elif command -v setfattr >/dev/null 2>&1; then
  prand 1024 m7 > meta/xattr.txt
  setfattr -n user.breeze.assurance -v 'xattr-value-1' meta/xattr.txt 2>/dev/null || true
fi

# --- many small files ---------------------------------------------------------
mkdir -p many
i=0
while [ $i -lt "$MANY" ]; do
  d=$((i / 1000))
  mkdir -p "many/d$d"
  printf 'file %06d ' "$i" > "many/d$d/f$i.txt"
  prand 1000 "many$i" >> "many/d$d/f$i.txt"
  i=$((i + 1))
done

# --- empty dirs + adversarial (filled by the driver at run time) ---------------
mkdir -p empty/a/b/c adversarial
prand 4096 adv1 > adversarial/perm-denied.txt; chmod 0000 adversarial/perm-denied.txt
prand 4096 adv2 > adversarial/locked-during-backup.txt
prand 4096 adv3 > adversarial/appended-during-backup.txt
prand 4096 adv4 > adversarial/deleted-during-backup.txt

echo "seeded $ROOT (big=$BIG many=$MANY)"
