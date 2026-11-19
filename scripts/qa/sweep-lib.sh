# shellcheck shell=bash
# Trusted-side helpers for scripts/qa/scheduled-ui-sweep.sh, sourced by it and by
# scripts/qa/tests/sweep-lib.test.sh. Everything here runs OUTSIDE the agent's
# sandbox and treats whatever the agent wrote as untrusted data: GitHub targets
# are checked against values the runner fixed before the agent started.
#
# Globals the caller sets: QA_HOME, QA_WORKTREE, QA_SOURCE_REPO, RUN_DIR, RUN_ID,
# QA_REPO, QA_CODE_REPO, NEW_SHA, PREV_SHA, SLICE, IN_SCOPE, ENVVALS,
# STACK_ENV_DIR, STATE, and a log() function.
# macOS /bin/bash is 3.2: no associative arrays, no ${x@Q}.
# shellcheck disable=SC2034  # globals are shared with the runner and the tests

QA_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# The generic patterns: the SECOND layer. The first is the known-value gate
# (_known_scan, build_envvals).
PREFIXED_SECRET_RE='sk_live_|sk_test_|rk_live_|sk-ant-|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-'
# brz_ keys are minted by the stack at runtime, so they cannot be known in
# advance. 16+ characters leaves the 12-character prefix the UI displays alone.
# Not matched with whitespace removed: the words after a displayed prefix would
# read as the rest of a key, so a minted key interleaved with spaces is a limit.
SECRET_RE="$PREFIXED_SECRET_RE|brz_[A-Za-z0-9_-]{16,}"
# Credentials written as user:pass@host: ONE rule for the whole class (Strix
# r10-r13 found a new spelling every round: a line break, an upper-case scheme,
# no scheme, //user:pass@host, a label in front, a space before ://). A body or
# title is refused when a ":" comes before an "@" with at least one character
# between them. That is checked on the raw bytes (USERINFO_ERE, per line: tokens
# of non-space characters) and on every normalised reading (_userinfo_scan:
# whitespace, invisibles and markdown removed, case-folded, percent- and
# entity-decoded, both fence readings), where it means: any ":" anywhere before
# any later "@". No scheme, label, host shape, port or distance exemptions.
# Deliberately broad: "Login: admin@example.com", "mailto:a@b.c", "10:30 @
# standup", image@sha256:digest and a host:port URL followed (anywhere) by an
# email are all refused. The agent is told never to write "@" (SKILL.md), and
# the runner's own bodies carry none (fingerprint_diff, boot_log_excerpt, the
# "main <sha>" wording). What passes: an "@" with no ":" anywhere before it.
USERINFO_ERE=':[^[:space:]]+@'
QA_BODY_MAX=60000
# _gate_clean <grep args...>: true only when grep positively reports "no match"
# (exit 1). A match (0), an error (2) or death by a signal (>128) all reject, so
# a check that cannot run never reads as "nothing found".
_gate_clean() { local rc=0; LC_ALL=C grep "$@" >/dev/null 2>&1 || rc=$?; [ "$rc" -eq 1 ]; }
# _body_scan <file> <max>: one process reads at most <max>+1 bytes, once, and
# prints "clean" only when the file is non-empty, within <max>, NUL-free and has
# no long token-like run: 40+ chars mixing upper, lower AND digits (JWT/base64/
# API keys; hyphenated slugs and 40-hex SHAs don't trip it). No pipeline, so no
# stage can be cut short (SIGPIPE under pipefail) and turn a hit into a miss.
_body_scan() {
  /usr/bin/python3 -I -c '
import re, sys
limit = int(sys.argv[2])
with open(sys.argv[1], "rb") as f:
    data = f.read(limit + 1)
if not data or len(data) > limit or b"\0" in data:
    sys.exit(3)
for m in re.finditer(rb"[A-Za-z0-9+/=_-]{40,}", data):
    t = m.group()
    if re.search(rb"[A-Z]", t) and re.search(rb"[a-z]", t) and re.search(rb"[0-9]", t):
        sys.exit(3)
print("clean")
' "$1" "$2" 2>/dev/null
}
# _norm_scan <file> <max> <envvals>: the same checks again on two normalised
# copies of the body (Strix r10), printing "clean" only when both pass. The
# raw checks match per line and the body is published with its layout intact,
# so a secret broken over lines, interleaved with spaces or zero-width
# characters, or wrapped in code fences / quote / table / emphasis markers would
# pass them and still read whole on GitHub. Every line is NFKC-folded, fence
# lines (with their info string) are dropped, and control, format (zero-width,
# soft hyphen, bidi) and combining characters and the markdown punctuation
# ` * ~ > | \ # are removed. Then:
#   flat   -- every whitespace character removed too. SECRET_RE (any space in
#             it made optional) and each literal .env value, normalised the
#             same way (when still >= 8 chars), must not occur.
#   joined -- lines joined, a line with no space in it with no separator, two
#             lines of words with one space. SECRET_RE must not occur.
#   chains -- consecutive lines that are nothing but 12+ token characters
#             ([A-Za-z0-9_-]), joined, must not hold _body_scan's long
#             token-like run. The heuristic is not run on the flat or joined
#             copy: with spaces or line breaks gone, ordinary prose, route
#             lists, key/value lines and a SHA next to a word form 40-char
#             mixed-case runs, so nearly every report would be refused. A
#             prefix-less token cut into short pieces or interleaved with
#             words therefore stays out of a heuristic's reach; known values
#             and prefixed tokens do not.
# Credentials written as user:pass@host are not checked here: _userinfo_scan
# holds the one class rule (see USERINFO_ERE).
# Every check runs twice: with fence lines dropped, and with only their fence
# markers stripped (text after a marker is content GitHub shows). Code points
# that render blank without being format characters (Hangul fillers, the
# braille blank, Khmer inherent vowels) are dropped as well. Look-alike letters
# (Cyrillic s) and visible separators (s.k.-) are an accepted limit of the
# normalisation; body_ok's printable-ASCII allow-list (Strix r15) refuses
# non-ASCII bytes before these scans run, so the stripping here is a second layer.
# _QA_NORM_PY: the reading and normalising shared by _norm_scan, _userinfo_scan and _known_scan.
_QA_NORM_PY='
import re, sys, unicodedata
path, limit, envvals = sys.argv[1], int(sys.argv[2]), sys.argv[3]
with open(path, "rb") as f:
    data = f.read(limit + 1)
if not data or len(data) > limit or b"\0" in data:
    sys.exit(3)
# Display order is not byte order: a right-to-left character or bidi control
# reorders the text on screen ("@" first in the bytes, user:pass@host on the
# page; a value reversed). Reports are left-to-right, so any refuses the body.
RTL = {"R", "AL", "RLE", "RLO", "RLI", "LRE", "LRO", "LRI", "FSI", "PDF", "PDI"}
if any(unicodedata.bidirectional(c) in RTL for c in data.decode("utf-8", "replace")):
    sys.exit(3)
BREAKS = re.compile("[\n\r\v\f\x1c\x1d\x1e\x85  ]")
FENCE = re.compile(r"\A[\s>]*(`{3,}|~{3,})")   # a fence line, info string and all
MD = set("`*~>|\\#")
DROP = {"Cc", "Cf", "Cs", "Co", "Cn", "Mn", "Me", "Zl", "Zp"}
BLANK = {"\u115f", "\u1160", "\u17b4", "\u17b5", "\u180e", "\u2800", "\u3164", "\uffa0"}
def norm_line(line, keep_spaces):
    out = []
    for ch in line:
        if ch in MD or ch in BLANK:
            continue
        if ch.isspace():
            if keep_spaces and out and out[-1] != " ":
                out.append(" ")
            continue
        if unicodedata.category(ch) in DROP:
            continue
        out.append(ch)
    return "".join(out).strip()
TOKEN_LINE = re.compile(r"\A[A-Za-z0-9_-]{12,}\Z")
def lines_of(b, drop_fences=True):
    t = unicodedata.normalize("NFKC", b.decode("utf-8", "replace"))
    if drop_fences:
        return [ln for ln in BREAKS.split(t) if not FENCE.match(ln)]
    return [FENCE.sub("", ln) for ln in BREAKS.split(t)]
def flat_of(lines):
    return "".join(norm_line(ln, False) for ln in lines)
def canon(s):
    return norm_line(unicodedata.normalize("NFKC", unicodedata.normalize("NFKC", s).casefold()), False)
def squeeze(s):
    # Whitespace and invisible characters go; markdown stays until after decoding
    # (the # of an entity, the %23 of a #).
    return "".join(c for c in s if not c.isspace() and c not in BLANK and unicodedata.category(c) not in DROP)
def decodings(lines):
    # The body flattened (whitespace, invisibles, markdown gone, case-folded),
    # and again percent-, plus- and entity-decoded, three rounds.
    import html, urllib.parse
    seen = {squeeze("".join(lines)), flat_of(lines)}
    todo = list(seen)
    for _ in range(3):
        found = []
        for s in todo:
            for d in (urllib.parse.unquote(s), urllib.parse.unquote_plus(s), html.unescape(s)):
                d = squeeze(d)
                if d not in seen:
                    seen.add(d)
                    found.append(d)
        todo = found
    return {canon(s) for s in seen}
'
_norm_scan() {
  /usr/bin/python3 -I -c "$_QA_NORM_PY"'
secret, prefixed = sys.argv[4], sys.argv[5]
def joined_of(lines):
    # A line with no space in it (a fragment) joins its neighbours with no
    # separator; two lines of words join with one space.
    out, prev = "", None
    for ln in lines:
        cur = norm_line(ln, True)
        if not cur:
            continue
        if prev is not None:
            out += "" if (" " not in prev or " " not in cur) else " "
        out += cur
        prev = cur
    return out
def token_chains(lines):
    # Runs of consecutive lines that are nothing but token characters, joined.
    # A blank line, a heading or a line of words ends a run, so a SHA on one
    # line and a word on the next do not read as one token.
    chains, cur = [], ""
    for ln in lines:
        n = norm_line(ln, True)
        if n and not ln.lstrip(" >").startswith("#") and TOKEN_LINE.match(n):
            cur += n
            continue
        if cur:
            chains.append(cur)
        cur = ""
    if cur:
        chains.append(cur)
    return chains
def tokenlike(s):
    for m in re.finditer(r"[A-Za-z0-9+/=_-]{40,}", s):
        t = m.group()
        if re.search("[A-Z]", t) and re.search("[a-z]", t) and re.search("[0-9]", t):
            return True
    return False
for drop in (True, False):
    lines = lines_of(data, drop)
    flat, joined = flat_of(lines), joined_of(lines)
    if re.search(prefixed.replace(" ", " ?"), flat) or re.search(secret, joined):
        sys.exit(3)
    if any(tokenlike(c) for c in token_chains(lines)):
        sys.exit(3)
print("clean")
' "$1" "$2" "$3" "$SECRET_RE" "$PREFIXED_SECRET_RE" 2>/dev/null
}
# _userinfo_scan <file> <max>: the user:pass@host class rule (see USERINFO_ERE)
# on every normalised reading of the body: flattened (whitespace, invisibles and
# markdown removed, NFKC case-folded) and percent-/entity-decoded, with fence
# lines dropped and with only their markers stripped. Refused when any ":" comes
# before any later "@" with at least one character between. Prints "clean" only
# when no reading has one; anything else (oversize, NUL, a crash) refuses.
_userinfo_scan() {
  /usr/bin/python3 -I -c "$_QA_NORM_PY"'
def userinfo(s):
    i = s.find(":")
    return i != -1 and s.rfind("@") >= i + 2
for drop in (True, False):
    if any(userinfo(s) for s in decodings(lines_of(data, drop))):
        sys.exit(3)
print("clean")
' "$1" "$2" "" 2>/dev/null
}
# _known_scan <file> <max> <envvals>: the PRIMARY gate (Strix r12). The agent can
# only meet secrets that exist on this machine, so build_envvals lists them and
# this refuses a body holding any of them, whatever its spelling. Body and value
# are both case-folded and stripped of whitespace, control, zero-width and
# markdown characters, on both fence readings. The body is also read percent-
# and entity-decoded (three rounds). Each value is looked for plain, as base64
# at all three byte alignments in both alphabets, and as hex with or without
# separators. A value of 24+ opaque characters is refused on any 16-character
# piece, so halves separated by prose are caught too. The limit: a transform
# the scan does not undo (reversed, rot13, enciphered) or pieces under 16.
_known_scan() {
  /usr/bin/python3 -I -c "$_QA_NORM_PY"'
import base64
MIN_VALUE, PIECE = 8, 16
def b64_forms(raw):
    # The characters of base64(raw) that do not depend on what surrounds raw.
    for pad in range(3):
        e = base64.b64encode(b"\0" * pad + raw).decode().rstrip("=")
        core = e[(8 * pad + 5) // 6:]
        if (pad + len(raw)) % 3:
            core = core[:-1]
        if len(core) >= MIN_VALUE:
            yield core.casefold()
            yield core.translate(str.maketrans("+/", "-_")).casefold()
plain, b64, hexed, pieces = set(), set(), set(), set()
with open(envvals, "rb") as f:
    for raw in f.read().splitlines():
        c = canon(raw.decode("utf-8", "replace"))
        if len(c) < MIN_VALUE:
            continue
        plain.add(c)
        b64.update(b64_forms(raw))
        hexed.add(raw.hex())
        if re.fullmatch(r"[a-z0-9_+/=-]{24,}", c):
            pieces.update(c[i:i + PIECE] for i in range(len(c) - PIECE + 1))
for drop in (True, False):
    for s in decodings(lines_of(data, drop)):
        if any(v in s for v in plain) or any(v in s for v in b64):
            sys.exit(3)
        for sep in (r"0x|[:,;._-]", r"x|[:,;._-]"):   # 0x41,0x42 and \\x41\\x42
            h = re.sub(sep, "", s)
            if any(v in h for v in hexed):
                sys.exit(3)
        if pieces and any(s[i:i + PIECE] in pieces for i in range(len(s) - PIECE + 1)):
            sys.exit(3)
print("clean")
' "$1" "$2" "$3" 2>/dev/null
}
# list_env_files <dir>: NUL-separated non-example .env* files/symlinks under <dir>.
list_env_files() {
  find "$1" \( -name node_modules -o -name .git \) -prune -o \
    -name '.env*' ! -name '*.example' \( -type f -o -type l \) -print0
}
# _stack_container_env <project>: the environment of every container in the
# stack, one KEY=value per line. Compose derives values no env file holds.
_stack_container_env() {
  local ids
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$1")" || return 1
  [ -n "$ids" ] || return 1
  # shellcheck disable=SC2086  # one argument per container id
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $ids
}
# build_envvals [project]: ENVVALS, every secret value the agent could meet, one
# per line, 8+ characters: each .env* in the worktree (.env.stack included),
# the seeded passwords and, given the stack project, its descriptor and the real
# environment of its containers. URLs also give their userinfo parts. A value is
# left out only when it is public by shape and its key does not name a secret
# (a URL without credentials on a local host or with a path of plain words, a
# path, email, image ref, number, word, display name or config word), or when
# the runner hands it to the agent to quote (stack URLs, container names, the
# admin email): otherwise every report would be refused. Replaced atomically; a
# failure leaves the previous list and returns non-zero.
build_envvals() {
  local project="${1:-}" f tmp dump="" rc=0 sources=()
  while IFS= read -r -d '' f; do sources+=("$f"); done < <(list_env_files "$QA_WORKTREE")
  tmp="$(umask 077; mktemp "$ENVVALS.XXXXXX")" || return 1
  if [ -n "$project" ]; then
    dump="$(umask 077; mktemp "$ENVVALS.env.XXXXXX")" || { rm -f "$tmp"; return 1; }
    _stack_container_env "$project" > "$dump" || rc=1
    sources+=("$dump")
  fi
  if [ "$rc" -eq 0 ]; then
    /usr/bin/python3 -I -c '
import json, os, re, sys, urllib.parse
out, descriptor, need_descriptor, sources = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4:]
MIN_VALUE = 8
SEEDED = ["BreezeAdmin123!", "PortalTest123!"]   # wt-stack admin, E2E portal user
SECRET_WORDS = {"SECRET", "SECRETS", "TOKEN", "TOKENS", "PASSWORD", "PASSWD", "PWD", "PASS", "PASSPHRASE", "KEY", "KEYS",
                "KEYRING", "APIKEY", "PEPPER", "SALT", "CREDENTIAL", "CREDENTIALS", "PRIVATE", "COOKIE", "DSN", "JWK"}
STRONG_WORDS = {"SECRET", "SECRETS", "TOKEN", "TOKENS", "PASSWORD", "PASSWD", "PASSPHRASE", "PRIVATE", "CREDENTIAL",
                "CREDENTIALS"}
METADATA = {"ID", "KID", "TTL", "MINUTES", "HOURS", "HOUR", "DAYS", "SECONDS", "MS", "VERSION", "URL", "ENABLED", "MODE",
            "LIMIT", "SOURCE", "FILE", "PATH", "REF", "NAME", "PROVIDER", "ENFORCE", "AUDIENCE", "ISSUER", "DOMAIN",
            "HOST", "PORT", "ALGORITHM", "ALG", "TYPE", "SECURE", "SAMESITE", "PREFIX", "LENGTH", "BYTES"}
LOCAL_HOST = re.compile(r"(?i)(?:localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+|[a-z0-9.-]+\.(?:local|localhost|internal|test))(?::\d{1,5})?")
PUBLIC_KEYS = {"PATH", "HOME", "PWD", "OLDPWD", "HOSTNAME", "LANG", "LC_ALL", "TERM", "USER", "SHELL", "SHLVL"}
URL_USERINFO = re.compile(r"[a-z][a-z0-9+.-]*://([^/?#@\s]*)@", re.I)
values = set()
def add(v):
    v = v.strip()
    if len(v) >= MIN_VALUE and "\n" not in v:
        values.add(v)
def secret_key(key):
    parts = key.upper().split("_")
    if parts[-1] in SECRET_WORDS:
        return True
    return parts[-1] not in METADATA and any(p in STRONG_WORDS for p in parts)
def config_word(v):
    return re.fullmatch(r"[a-z0-9]+(?:[-_./:][a-z0-9]+)*", v) is not None and all(
        s.isalpha() or len(s) <= 6 for s in re.split(r"[-_./:]", v))
def public_value(key, v):
    items = [x for x in re.split(r"[,\s]+", v) if x]
    if len(items) > 1:   # a list is public when every item is
        return all(public_value(key, x) for x in items)
    if key.endswith(("_IMAGE", "_IMAGE_REF")) or re.search(r"@sha256:[0-9a-f]{64}\Z", v):
        return True
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?", v):
        return True
    if re.fullmatch(r"(?i)[0-9a-f:.]*[:.][0-9a-f:.]*(?:/\d{1,3})?", v) and re.search(r"\d", v):
        return True   # an IP address or CIDR
    if re.fullmatch(r"\.{1,2}/[\w./-]*", v):
        return True
    if re.fullmatch(r"(?i)true|false|yes|no|on|off|-?\d+(?:\.\d+)?", v):
        return True
    if re.fullmatch(r"v?\d+(?:\.\d+)+(?:[-+][\w.]+)?", v):
        return True
    u = re.fullmatch(r"(?i)[a-z][a-z0-9+.-]*://([^/\s@?#]*)(/[^\s@?#]*)?", v)
    if u:
        segments = [p for p in (u.group(2) or "").split("/") if p]
        return LOCAL_HOST.fullmatch(u.group(1)) is not None or all(config_word(p.lower()) for p in segments)
    if re.fullmatch(r"[A-Za-z]+", v) or re.fullmatch(r"[A-Za-z][\w.,&()-]*(?: [\w.,&()-]+)+", v):
        return True   # a word, or a display name such as "Breeze RMM"
    if re.fullmatch(r"/[\w./-]*(?::/[\w./-]*)*", v) or re.fullmatch(r"[^\s@:/]+@[^\s@:/]+", v):
        return True
    return config_word(v)
def add_password(pw, user=""):
    for p in {pw, urllib.parse.unquote(pw)}:
        add(p)
        add(":" + p + "@")
        if user:
            add(user + ":" + p)
def add_url_parts(v):
    for m in URL_USERINFO.finditer(v):
        add(v)
        user, _, pw = m.group(1).partition(":")
        for u in {user, urllib.parse.unquote(user)}:
            if not public_value("", u):
                add(u)
        if pw:
            add_password(pw, user)
entries, env = [], {}
for src in sources:
    with open(src, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = re.match(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line.rstrip("\r\n"))
            if not m:
                continue
            key, v = m.group(1), m.group(2).strip()
            q = re.fullmatch(r"([\"\x27])(.*)\1(?:\s+#.*)?", v)
            v = q.group(2) if q else re.sub(r"\s+#.*$", "", v)
            if v:
                entries.append((key, v))
                env[key] = v
def expand(v):
    return re.sub(r"\$\{([A-Za-z_]\w*)(?::?-([^}]*))?\}", lambda m: env.get(m.group(1), m.group(2) or ""), v)
for key, raw in entries:
    if key in PUBLIC_KEYS:
        continue
    v = expand(raw)
    add_url_parts(v)
    if secret_key(key):
        add(v)
        for part in re.split(r"[,;\s]+", v):
            add(part)
            add(part.rsplit(":", 1)[-1])
        if key.endswith(("_PASSWORD", "_PASS", "_PASSWD")):
            add_password(v)
    elif not public_value(key, v):
        add(v)
if env.get("POSTGRES_PASSWORD"):
    add_password(env["POSTGRES_PASSWORD"], env.get("POSTGRES_USER", "breeze"))
for pw in SEEDED:
    add(pw)
keep = set(SEEDED)
quotable = set()
if os.path.exists(descriptor):
    with open(descriptor, encoding="utf-8") as f:
        d = json.load(f)
    admin = d["admin"]["password"]
    add(admin)
    keep.add(admin)
    quotable = {str(d.get(k, "")) for k in ("project", "baseUrl", "apiUrl", "portalUrl", "pgContainer", "redisContainer")}
    quotable.add(str(d["admin"].get("email", "")))
elif need_descriptor:
    sys.exit(1)
final = sorted(v for v in values if v in keep or v not in quotable)
with open(out, "w", encoding="utf-8") as f:
    f.write("".join(v + "\n" for v in final))
' "$tmp" "$QA_WORKTREE/.breeze-stack.json" "$([ -n "$project" ] && echo 1 || echo 0)" ${sources[@]+"${sources[@]}"} 2>/dev/null || rc=1
  fi
  [ -z "$dump" ] || rm -f "$dump"
  if [ "$rc" -eq 0 ]; then mv -f "$tmp" "$ENVVALS" || rc=1; fi
  rm -f "$tmp"
  return "$rc"
}
# body_ok <file>: gate for anything headed to GitHub (the private QA repo: still
# a sink other people read, so the gate stays as strict as it was). Fails
# CLOSED: the body passes only when every check positively reports it clean. A
# size it cannot bound, a missing redaction list or any tool failure rejects it.
body_ok() {
  local size verdict
  [ -f "$1" ] || return 1
  size="$(wc -c < "$1" | tr -d ' ')" || return 1
  case "$size" in ''|*[!0-9]*) return 1 ;; esac
  [ "$size" -gt 0 ] && [ "$size" -le "$QA_BODY_MAX" ] || return 1   # bounded before anything scans it
  # Printable-ASCII allow-list (Strix r15), before every other scan: published
  # output is an English machine report, so only 0x20-0x7E, \n and \t may
  # appear. Any other byte (zero-width, bidi, blank-rendering symbols,
  # homoglyphs, fullwidth, NBSP, CR, DEL, invalid UTF-8) refuses the body, so
  # the Unicode-hiding class is closed without listing code points. Non-ASCII
  # UI text found by the agent is reported as code points (U+00E9).
  _gate_clean -aq "[^ -~$(printf '\t')]" "$1" || return 1
  verdict="$(_body_scan "$1" "$QA_BODY_MAX")" || return 1
  [ "$verdict" = clean ] || return 1
  # Byte-wise matching (LC_ALL=C, -a): invalid UTF-8 must not turn the file
  # "binary" and hide what follows it (NULs are already refused above).
  _gate_clean -aEq "$SECRET_RE" "$1" || return 1
  _gate_clean -aEq "$USERINFO_ERE" "$1" || return 1   # user:pass@host, raw
  # Any literal .env value. The runner builds this list before anything is
  # published, so a missing or unreadable list is a failed check, not an empty one.
  [ -f "$ENVVALS" ] && [ -r "$ENVVALS" ] || return 1
  if [ -s "$ENVVALS" ]; then _gate_clean -aqF -f "$ENVVALS" "$1" || return 1; fi
  # The same checks on normalised copies: a secret split over lines,
  # interleaved or fenced is caught whole (Strix r10).
  verdict="$(_norm_scan "$1" "$QA_BODY_MAX" "$ENVVALS")" || return 1
  [ "$verdict" = clean ] || return 1
  # user:pass@host in any spelling: one class rule on every normalised reading.
  verdict="$(_userinfo_scan "$1" "$QA_BODY_MAX")" || return 1
  [ "$verdict" = clean ] || return 1
  # Every secret on this machine, however it is spelled or encoded (Strix r12).
  verdict="$(_known_scan "$1" "$QA_BODY_MAX" "$ENVVALS")" || return 1
  [ "$verdict" = clean ] || return 1
  return 0
}
# text_ok <string>: body_ok for a single field (an issue title), via a private file.
text_ok() {
  local tf rc
  tf="$(mktemp "${PUBLISH_DIR:-$QA_HOME}/.field.XXXXXX")" || return 1
  printf '%s' "$1" > "$tf"; body_ok "$tf"; rc=$?
  rm -f "$tf"; return "$rc"
}
# fingerprint_diff <previous-fingerprint-text> <fingerprint-file>: the drift
# section's diff lines (- old, + new). Its "@"s are the two runner-known shapes,
# reworded so the class rule (USERINFO_ERE) does not refuse the issue:
# name:tag@sha256:<hex> -> "name:tag digest sha256:<hex>" and the packageManager
# pin's "pnpm@1.2.3" -> "pnpm 1.2.3". Only the published text is reworded, never
# the fingerprint (that would read as a change next run). Any other "@" is left
# alone, so the issue is refused rather than published with it.
fingerprint_diff() {
  diff <(printf '%s\n' "$1") "$2" | grep -E '^[<>]' \
    | sed -E 's/^</-/; s/^>/+/; s/@(sha(256|384|512):[0-9a-f]{64,128})/ digest \1/g; s/("packageManager":"[A-Za-z0-9._-]+)@/\1 /'
}
# boot_log_excerpt <container-log>: the published excerpt of a failed
# container's log. Error-signature lines only, the last 8, each cut to 240
# characters; lines holding a literal .env value, a SECRET_RE match, a long
# token-like run or any "@" (the class rule refuses the issue on one) dropped.
# The full log stays on the QA Mac.
boot_log_excerpt() {
  grep -E 'CRITICAL|FATAL|Error:|error:|ERROR' "$1" | tail -8 | cut -c1-240 \
    | { if [ -s "$ENVVALS" ]; then grep -viF -f "$ENVVALS"; else cat; fi; } \
    | grep -Ev "$SECRET_RE" | grep -Ev '[A-Za-z0-9+/=_-]{48,}|@'
}
# fence_text <file>: rewrite agent-written text in place into the only form the
# publisher posts: the text verbatim inside a fenced code block it cannot close.
# This removes the capability instead of parsing for it: GitHub renders no link,
# autolink, image, HTML, entity, mention or issue reference inside a code block,
# so however a URL, host, mention or reference is spelled, it stays inert text.
# A fence closes only on a line of at least as many backticks as it opened with,
# and the fence is longer than every backtick run in the text. Nothing outside
# the fence comes from the agent (the earlier runner-written "Related: #N" line
# is gone: in the private QA repo a #N would name its own issue N, not the
# public PR the agent meant). As a second layer, every @ gets a zero-width
# joiner and every `://` / `www.` is defanged (`[:]//`, `www[.]`) for the raw
# text in notification emails. A failure means the text is not published.
fence_text() {
  /usr/bin/python3 -I - "$1" <<'PY'
import re, sys

path = sys.argv[1]
with open(path, "rb") as f:
    text = f.read()
text = text.replace(b"@", b"@\xe2\x80\x8d")
# Notification emails carry the raw text, and mail clients autolink it: defang
# every scheme separator and www. host, with no exceptions.
text = text.replace(b"://", b"[:]//")
text = re.sub(rb"(?i)\b(www)\.", rb"\1[.]", text)
longest = max((len(r) for r in re.findall(rb"`+", text)), default=0)
fence = b"`" * max(3, longest + 1)
out = fence + b"text\n" + text + (b"" if text.endswith(b"\n") else b"\n") + fence + b"\n"
with open(path, "wb") as f:
    f.write(out)
PY
}
# safe_title <string>: an issue title as plain text. Characters that form
# mentions, references, entities, HTML or code (@ # & < > ` \) and anything
# outside printable ASCII are dropped (whitespace becomes a space), and a
# scheme separator is defanged. What remains is words and punctuation.
safe_title() {
  # \047 \042 \133 \135 = ' " [ ]  (octal: a bare [ opens a tr class)
  printf '%s' "$1" | LC_ALL=C tr '\t\r\n' '   ' | LC_ALL=C tr -cd 'A-Za-z0-9 .,:;!?()/_+=%*\047\042\133\135-' \
    | sed -e 's#://#[:]//#g' -e 's/  */ /g' -e 's/ *$//'
}

# ---------------------------------------------------------------------------
# Agent sandbox (Seatbelt). Applied with sandbox-exec to the whole agent process
# tree: claude, its Bash commands (gh), the Playwright MCP server and Chromium.
# Unlike Claude Code permission rules, it binds every tool and every child
# process, and the agent cannot change it once started.
#   - network: two loopback ports only -- the QA stack (Caddy) and the model
#     forwarder -- so no other service listening on this
#     Mac's loopback (the egress proxy included) is reachable. Unix sockets are denied too (except the agent's own
#     TMPDIR), which also blocks DNS (mDNSResponder), docker.sock and ssh-agent;
#     hostname lookups for the proxy's upstreams happen in the proxy.
#   - reads: an allow-list under the home directory, QA_HOME, the developer
#     checkout, the per-user temp/cache dirs and /tmp. File contents there are
#     denied except RUN_DIR, the worktree, the agent's TMPDIR and claude config
#     dir, the runner's scripts and MCP install, the claude and node files
#     themselves (not their directories), Playwright's browsers, user fonts and
#     Chrome's own lock dirs. ~/.claude, ~/.claude.json, ~/.ssh, ~/.config,
#     shell history and rc files, every keychain and the checkout's .env files
#     are unreadable without being named. System paths outside the home
#     directory stay readable.
#   - credentials: the agent holds none. Its model calls go to the runner's
#     loopback forwarder (model-forwarder.py), which adds the agent's own
#     long-lived token (claude setup-token; agent_token_path) outside the
#     sandbox; the agent has a placeholder. The developer's keychains -- the
#     login keychain included -- are neither readable nor writable, so no
#     claude.ai login, refresh token or other saved password of the developer's
#     is within reach, and Chromium (Playwright: --use-mock-keychain
#     --password-store=basic) needs none.
#   - secrets: env files (parked or not), the redaction list, machine overrides,
#     ~/.ssh, git credential files, the egress audit log, other runs and this
#     run's logs/transcripts are also denied by name, wherever they live.
#   - writes: an allow-list, not a deny-list. Every write is denied except to
#     RUN_DIR (minus the runner's inputs, its logs/transcripts and any
#     .claude/CLAUDE.md), the agent's TMPDIR, its throwaway claude config dir
#     (CLAUDE_CONFIG_DIR, reset each run) and the few /dev nodes a process
#     needs. A path this profile does not name -- a PATH directory such as
#     ~/.local/bin or /opt/homebrew/bin, ~/.claude or ~/.claude.json, the npx and
#     Playwright caches, shell rc files, LaunchAgents -- fails closed, so nothing
#     the next unsandboxed run executes or loads can be planted. The worktree,
#     the developer checkout and runner state are additionally denied by name.
#   - GitHub: the agent has NO route to it (not on the egress allowlist), no
#     reader for it and cannot read gh's config/token store. Everything it
#     needs from GitHub the runner computes first and hands it as read-only
#     files: the merged-since list from local git (no titles or bodies) and the
#     open qa-sweep issues of the private QA repo (number + title).
#   - well-known credential stores (~/.aws, ~/.kube, ~/.docker, ~/.gnupg, ...)
#     and the developer's real browser profiles are unreadable as well.
# ---------------------------------------------------------------------------
_sb_real() {   # _sb_real <path>: physical path (parent must exist), refuses quotes/newlines
  local d b; d="$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)" || return 1
  b="$(basename "$1")"; [ "$b" = / ] && b=""
  case "$d/$b" in *'"'*|*$'\n'*|*'\'*) return 1 ;; esac
  printf '%s' "${d%/}/$b"
}
_sb_re() { printf '%s' "$1" | sed -e 's/[]*.[^$(){}?+|]/\\&/g'; }   # regex-escape a path ("[." would open a BSD collating element)
# _sb_ancestors <path...>: a (literal) rule for each path and every directory
# above it. Seatbelt matches the path at access time, so renaming a parent would
# carry a protected file out from under its rule. Creating children stays allowed.
_sb_ancestors() {
  local p
  for p in "$@"; do
    while [ -n "$p" ] && [ "$p" != / ]; do printf '  (literal "%s")\n' "$p"; p="$(dirname "$p")"; done
  done | sort -u
}
# egress_log_path: the proxy's audit trail. Outside RUN_DIR (the agent's scratch
# space) and denied to the agent in qa_sandbox_profile.
egress_log_path() { printf '%s' "$QA_HOME/.audit/egress-$RUN_ID.log"; }
# agent_claude_dir: the agent's CLAUDE_CONFIG_DIR. Its own, emptied before every
# agent run (reset_agent_claude_dir), so the agent never writes the developer's
# ~/.claude or ~/.claude.json and nothing it writes there outlives the run. It
# is also the agent's CLAUDE_SECURESTORAGE_CONFIG_DIR, so claude never looks for
# a developer login profile.
agent_claude_dir() { printf '%s' "${AGENT_CLAUDE_DIR:-$QA_HOME/.claude-agent}"; }
reset_agent_claude_dir() {
  local d; d="$(agent_claude_dir)"
  rm -rf "$d" && ( umask 077; mkdir -p "$d" )
}

# The agent's credential: a long-lived claude.ai token of its own (`claude
# setup-token`: subscription billing, nothing to refresh or rotate), stored by
# install-schedule.sh --agent-token. The AGENT NEVER HOLDS IT (Strix r10): the
# runner reads it and pipes it to the model forwarder (start_model_forwarder),
# which adds it to the agent's model API requests outside the sandbox. The
# agent gets a placeholder and ANTHROPIC_BASE_URL; the sandbox denies the file
# and every keychain, so its environment, files and process memory hold none.
agent_token_path() { printf '%s' "${QA_AGENT_TOKEN_FILE:-$QA_HOME/.agent-auth/oauth-token}"; }
AGENT_OAUTH_TOKEN=""
# load_agent_token: AGENT_OAUTH_TOKEN from agent_token_path. Refuses a missing,
# linked, foreign or group/world-readable file and anything but one token line.
load_agent_token() {
  AGENT_OAUTH_TOKEN=""
  local f t; f="$(agent_token_path)"
  [ -f "$f" ] && [ ! -L "$f" ] && [ -O "$f" ] || { log "agent token: $f missing, linked or not ours"; return 1; }
  case "$(stat -f '%Lp' "$f" 2>/dev/null)" in 400|600) ;; *) log "agent token: $f must be mode 600"; return 1 ;; esac
  [ "$(wc -l < "$f" | tr -d ' ')" -le 1 ] || { log "agent token: $f must hold one line"; return 1; }
  t="$(head -n 1 "$f")"
  [[ "$t" =~ ^sk-ant-oat[0-9][0-9]-[A-Za-z0-9_-]+$ ]] && [ "${#t}" -ge 40 ] && [ "${#t}" -le 512 ] || { log "agent token: $f does not hold a claude setup-token token"; return 1; }
  AGENT_OAUTH_TOKEN="$t"
}
# What the agent's claude sends as its OAuth token. Not a secret: the forwarder
# discards it and sets the real one. It makes claude run in subscription
# (oauth_token) mode, with the same request shape as a real login.
AGENT_TOKEN_PLACEHOLDER="qa-model-forwarder-adds-the-credential"

qa_sandbox_profile() {  # qa_sandbox_profile <out-file>
  local out="$1" home qh wt src run st sed_env atmp acfg gitc audit lib p
  home="$(_sb_real "$HOME")" && qh="$(_sb_real "$QA_HOME")" && wt="$(_sb_real "$QA_WORKTREE")" \
    && src="$(_sb_real "$QA_SOURCE_REPO")" && run="$(_sb_real "$RUN_DIR")" \
    && atmp="$(_sb_real "${AGENT_TMP:-$QA_HOME/.t}")" \
    && acfg="$(_sb_real "$(agent_claude_dir)")" \
    && st="$(_sb_real "$STACK_ENV_DIR")" && sed_env="$(_sb_real "$ENVVALS")" \
    && lib="$(_sb_real "$QA_LIB_DIR")" || { log "sandbox: bad path"; return 1; }
  # The agent's network is these two loopback ports and nothing else. The
  # egress proxy is not one of them: the agent reaches the model only through
  # the forwarder, which holds the credential and uses the proxy itself.
  for p in "${QA_STACK_PORT:-}" "${MODEL_PORT:-}"; do
    [[ "$p" =~ ^[0-9]{1,5}$ ]] || { log "sandbox: stack/forwarder port missing or bad ('$p')"; return 1; }
  done
  audit="$qh/.audit"
  # The shared git dir: a checkout that is a linked worktree keeps config and hooks there.
  gitc="$(cd "$src" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null || echo .git)" 2>/dev/null && pwd -P)"
  gitc="$(_sb_real "${gitc:-$src/.git}")" || { log "sandbox: bad git dir"; return 1; }
  local wt_re src_re run_re home_re locked dtmp chrome_tmp="" tok
  wt_re="$(_sb_re "$wt")"; src_re="$(_sb_re "$src")"; run_re="$(_sb_re "$run")"; home_re="$(_sb_re "$home")"
  # The agent's token file, wherever QA_AGENT_TOKEN_FILE puts it (it gets the token in its env).
  tok="$(_sb_real "$(agent_token_path)" 2>/dev/null)" || tok="$qh/.agent-auth/oauth-token"
  # Chrome creates its ProcessSingleton lock dir in the per-user temp dir
  # whatever TMPDIR says; allow only its own randomly named dirs there.
  dtmp="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)"; dtmp="${dtmp%/}"
  if [ -n "$dtmp" ] && dtmp="$(_sb_real "$dtmp")"; then
    chrome_tmp="  (regex #\"^$(_sb_re "$dtmp")/(com\\.google\\.Chrome|org\\.chromium\\.Chromium)\\.[^/]+(/.*)?\$\")"
  fi
  locked="$(_sb_ancestors "$run" "$audit" "$wt" "$src" "$gitc" "$lib" "$home/.config/gh" "$home/.config/git" \
    "$home/.claude/skills" "$home/.ssh" "$home/Library/LaunchAgents")"
  # The toolchain the agent runs from: claude and node, wherever they are
  # installed (a per-user install lives under the home directory, which is
  # otherwise unreadable). Exactly the PATH entry and the file it resolves to,
  # never their directories: a shared bin dir (~/bin, ~/.local/bin) holds other
  # tools and scripts. A JS entry point (an npm-installed claude) gets its own
  # package directory, unless that is a bin dir or the home directory itself.
  local tools="" t tr td
  for t in claude node; do
    t="$(command -v "$t" 2>/dev/null)" || continue
    case "$t" in /*) ;; *) continue ;; esac
    t="$(_sb_real "$t")" && tr="$(/usr/bin/python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$t")" \
      && tr="$(_sb_real "$tr")" || continue
    tools="$tools  (literal \"$t\")
  (literal \"$tr\")
"
    case "$tr" in
      *.js|*.mjs|*.cjs)
        td="$(dirname "$tr")"
        case "$td" in "$home"|*/bin) log "sandbox: refusing to allow all of $td for $t" ;;
          *) tools="$tools  (subpath \"$td\")
" ;; esac ;;
    esac
  done
  # Per-user temp and cache dirs and the shared temp dirs sit outside the home
  # directory and hold other programs' files (other sessions' scratch, caches),
  # so they are default-deny for reads as well. The agent has its own TMPDIR.
  local udir tmps=""
  udir="$(getconf DARWIN_USER_DIR 2>/dev/null)"; udir="${udir%/}"
  if [ -n "$udir" ] && udir="$(_sb_real "$(dirname "$udir")")"; then tmps="(subpath \"$udir\") "; fi
  for p in /private/tmp /private/var/tmp; do [ -d "$p" ] && tmps="$tmps(subpath \"$p\") "; done
  # xcrun's tool-path cache, read by the /usr/bin/python3 shim on every start.
  local xcrun_db=""
  [ -n "$dtmp" ] && xcrun_db="
  (literal \"$dtmp/xcrun_db\")"
  ( umask 077; cat > "$out" ) <<SB
(version 1)
(allow default)

;; network: two loopback ports -- the QA stack and the model forwarder
(deny network-outbound)
(allow network-outbound
  (remote ip "localhost:$QA_STACK_PORT")
  (remote ip "localhost:$MODEL_PORT"))
;; unix sockets only in the agent's own TMPDIR (Playwright <-> Chromium)
(allow network-outbound (remote unix-socket (subpath "$atmp")))

;; writes: an allow-list. Deny every write, then allow only what the run needs.
;; Last match wins, so the secret and read-only denies below still carve the
;; runner's inputs out of RUN_DIR. Anything not named here fails closed.
(deny file-write*)
(allow file-write*
  (subpath "$run")
  (subpath "$atmp")
  (subpath "$acfg")
$chrome_tmp
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/tty")
  (literal "/dev/dtracehelper")
  (regex #"^/dev/fd/[0-9]+$"))

;; reads under the home directory: an allow-list. Every file's contents and
;; every directory listing under $home are denied (transcripts and memory in
;; ~/.claude, ~/.claude.json, shell history and rc files, ~/.config, ~/.npmrc,
;; the developer's checkouts and their .env files, every other keychain file,
;; whatever a new tool stores next) except what the run needs. Metadata stays
;; readable so paths resolve. System paths outside $home stay readable. QA_HOME
;; (runner state), the developer checkout and its git dir are default-deny
;; wherever they live: the agent works in its own worktree.
(deny file-read-data (subpath "$home") (subpath "$qh") (subpath "$src") (subpath "$gitc"))
;; and the per-user temp/cache dirs plus /tmp and /var/tmp
(deny file-read-data $tmps(literal "/dev/null/qa-none"))
(allow file-read-data
$chrome_tmp$xcrun_db
  (subpath "$run")
  (subpath "$wt")
  (subpath "$atmp")
  (subpath "$acfg")
  (subpath "$lib")
  (subpath "$qh/mcp")
$tools  (subpath "$home/Library/Caches/ms-playwright")
  (subpath "$home/Library/Fonts")
  (literal "$home/.CFUserTextEncoding"))

;; secrets: unreadable (and unwritable) by every process in the tree. file-read-data
;; is named as well as file-read*: a rule for the narrower operation outranks one
;; for the wider, so without it the allow-list above (e.g. the worktree) would
;; win over these denies.
(deny file-read* file-read-data file-write*
  (subpath "$st")
  (literal "$sed_env")
  (literal "$qh/env.overrides")
  (subpath "$qh/.sandbox")
  (subpath "$qh/.publish")
  (subpath "$qh/.agent-auth")
  (literal "$tok")
  (subpath "$audit")
  ;; every keychain (login included): the agent signs in with its own token
  (subpath "$home/Library/Keychains")
  (regex #"^$wt_re/(.*/)?\.env[^/]*$")
  (regex #"^$src_re/(.*/)?\.env[^/]*$")
  (literal "$home/.git-credentials")
  (literal "$home/.config/git/credentials")
  (subpath "$home/.ssh")
  (subpath "$home/.config/gh")
  (subpath "$home/.aws")
  (subpath "$home/.kube")
  (subpath "$home/.docker")
  (subpath "$home/.gnupg")
  (subpath "$home/.password-store")
  (subpath "$home/.config/gcloud")
  (subpath "$home/.azure")
  (literal "$home/.netrc")
  (subpath "$home/Library/Cookies")
  (subpath "$home/Library/Application Support/Google/Chrome")
  (subpath "$home/Library/Application Support/Firefox")
  (subpath "$home/Library/Safari"))
;; contents only (file-read-data): RUN_DIR's parent must stay stat-able, or
;; claude cannot resolve --add-dir / its Edit rules for RUN_DIR
(deny file-read-data
  (require-all (subpath "$qh/runs") (require-not (subpath "$run")))
  (regex #"^$run_re/[^/]*\.(log|err)$")
  (regex #"^$run_re/transcript[^/]*$"))

;; read-only: the worktree, runner state, this run's trusted inputs, and the
;; places a planted file would outlive the run
(deny file-write*
$locked
  (subpath "$wt")
  (subpath "$src")
  (subpath "$gitc")
  (literal "$home/.gitconfig")
  (subpath "$home/.config/git")
  (subpath "$home/.config/gh")
  (subpath "$qh/bin")
  (subpath "$lib")
  (literal "$(_sb_real "$STATE")")
  (literal "$run/commits.tsv")
  (literal "$run/changed-files.tsv")
  (literal "$run/open-issues.tsv")
  (literal "$run/hosted-prs.txt")
  (literal "$run/mcp.json")
  (literal "$run/env-drift.md")
  (literal "$run/env-fingerprint.txt")
  (literal "$run/result")
  (subpath "$run/.claude")
  (regex #"^$run_re/[^/]*\.(log|err)$")
  (regex #"^$run_re/transcript[^/]*$")
  (regex #"^$run_re/(.*/)?CLAUDE(\.local)?\.md$")
  (subpath "$home/.claude/skills")
  (subpath "$home/.claude/commands")
  (subpath "$home/.claude/agents")
  (subpath "$home/.claude/hooks")
  (subpath "$home/.claude/plugins")
  (regex #"^$home_re/\.claude/(settings[^/]*\.json|CLAUDE\.md)$")
  (regex #"^$home_re/\.(zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|profile)$")
  (subpath "$home/Library/LaunchAgents"))
SB
}

# ---------------------------------------------------------------------------
# Egress proxy: the only route off the machine for the agent's traffic. Since
# Strix r10 its one client is the model forwarder (the agent cannot reach it):
# CONNECT to :443 of a fixed host allowlist (the model API only); all else is
# refused and logged to egress_log_path, which the agent cannot touch. GitHub
# is deliberately NOT on it: the agent does not read GitHub at all.
# The QA stack's own containers are bounded separately (isolate_stack): they
# run on an internal-only Docker network, so the app the agent administers
# cannot be told to call out either.
# ---------------------------------------------------------------------------
# Exact hostnames only (the proxy refuses suffix entries): the model API. The
# setup-token needs no refresh, and the forwarder sends nothing else.
QA_EGRESS_ALLOW="${QA_EGRESS_ALLOW:-api.anthropic.com}"
EGRESS_PID=""; EGRESS_PORT=""; EGRESS_LOG=""
# _start_daemon <port-var> <pid-var> <port-file> <cmd...>: start a loopback
# helper that writes its port to <port-file>, and wait for it.
_start_daemon() {
  local pv="$1" pidv="$2" pf="$3" port _; shift 3
  rm -f "$pf"
  "$@" &
  printf -v "$pidv" '%s' "$!"
  for _ in $(seq 1 50); do [ -s "$pf" ] && break; sleep 0.1; done
  port="$(tr -dc '0-9' < "$pf" 2>/dev/null)"
  printf -v "$pv" '%s' "$port"
  [ -n "$port" ] && kill -0 "${!pidv}" 2>/dev/null
}
start_egress_proxy() {
  EGRESS_LOG="$(egress_log_path)"
  ( umask 077; mkdir -p "$QA_HOME/.sandbox" "$(dirname "$EGRESS_LOG")" && : >> "$EGRESS_LOG" ) || return 1
  _start_daemon EGRESS_PORT EGRESS_PID "$QA_HOME/.sandbox/egress.port" \
    /usr/bin/python3 "$QA_LIB_DIR/egress-proxy.py" --allow "$QA_EGRESS_ALLOW" \
    --port-file "$QA_HOME/.sandbox/egress.port" --log "$EGRESS_LOG" || { stop_egress_proxy; return 1; }
  log "egress proxy on 127.0.0.1:$EGRESS_PORT (allow: $QA_EGRESS_ALLOW; audit log: $EGRESS_LOG)"
}
stop_egress_proxy() {
  [ -n "$EGRESS_PID" ] && kill "$EGRESS_PID" 2>/dev/null
  EGRESS_PID=""; EGRESS_PORT=""
}

# Model forwarder: the agent's only route to the model, and the only process
# holding its credential. Runs as the runner, outside the sandbox, on loopback;
# forwards POST /v1/messages (+ count_tokens) and nothing else, through the
# egress proxy, adding the token. Started after start_egress_proxy, before the
# profile is written. The token goes over a pipe on stdin (not argv, which any
# local process can list, nor the environment), and the runner drops its own
# copy once the forwarder holds it.
MODEL_PID=""; MODEL_PORT=""; MODEL_LOG=""
model_log_path() { printf '%s' "$QA_HOME/.audit/model-$RUN_ID.log"; }
start_model_forwarder() {
  local pf="$QA_HOME/.sandbox/model.port" port _
  [ -n "$AGENT_OAUTH_TOKEN" ] || { log "model forwarder: agent token not loaded"; return 1; }
  [[ "${EGRESS_PORT:-}" =~ ^[0-9]{1,5}$ ]] || { log "model forwarder: egress proxy not running"; return 1; }
  MODEL_LOG="$(model_log_path)"
  ( umask 077; mkdir -p "$QA_HOME/.sandbox" "$(dirname "$MODEL_LOG")" && : >> "$MODEL_LOG" ) || return 1
  rm -f "$pf"
  printf '%s\n' "$AGENT_OAUTH_TOKEN" | /usr/bin/python3 -I "$QA_LIB_DIR/model-forwarder.py" \
    --egress-port "$EGRESS_PORT" --port-file "$pf" --log "$MODEL_LOG" &
  MODEL_PID=$!
  for _ in $(seq 1 50); do [ -s "$pf" ] && break; sleep 0.1; done
  port="$(tr -dc '0-9' < "$pf" 2>/dev/null)"
  if [ -z "$port" ] || ! kill -0 "$MODEL_PID" 2>/dev/null; then stop_model_forwarder; return 1; fi
  MODEL_PORT="$port"
  AGENT_OAUTH_TOKEN=""   # the forwarder holds it now; the runner keeps no copy
  log "model forwarder on 127.0.0.1:$MODEL_PORT (POST /v1/messages only, via the egress proxy; audit log: $MODEL_LOG)"
}
stop_model_forwarder() {
  [ -n "$MODEL_PID" ] && kill "$MODEL_PID" 2>/dev/null
  MODEL_PID=""; MODEL_PORT=""
}

# build_agent_cmd <cmd...>: AGENT_CMD = <cmd> wrapped in the sandbox, with the
# model forwarder as its only route out. It holds no credential: every
# Anthropic credential variable (and any GitHub token) is removed and claude
# gets the forwarder's placeholder. Needs AGENT_PROFILE and MODEL_PORT.
build_agent_cmd() {
  AGENT_CMD=(/usr/bin/sandbox-exec -f "$AGENT_PROFILE"
    /usr/bin/env -u SSH_AUTH_SOCK -u GPG_AGENT_INFO -u DOCKER_HOST
    -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN
    -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_REFRESH_TOKEN
    -u CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR -u CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
    -u CLAUDE_CODE_USE_BEDROCK -u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CODE_USE_FOUNDRY
    -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy
    "ANTHROPIC_BASE_URL=http://127.0.0.1:$MODEL_PORT"
    "CLAUDE_CODE_OAUTH_TOKEN=$AGENT_TOKEN_PLACEHOLDER"
    "NO_PROXY=localhost,127.0.0.1,::1" "no_proxy=localhost,127.0.0.1,::1"
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
    "TMPDIR=${AGENT_TMP:-$QA_HOME/.t}"
    "CLAUDE_CODE_TMPDIR=${AGENT_TMP:-$QA_HOME/.t}"
    "TMPPREFIX=${AGENT_TMP:-$QA_HOME/.t}/zsh"
    # Playwright registers each browser in ~/Library/Caches/ms-playwright/b,
    # which other Playwright clients trust (one rm -rf's a descriptor's
    # userDataDir), so it stays read-only and the agent's registry is its own.
    "PWTEST_SERVER_REGISTRY=${AGENT_TMP:-$QA_HOME/.t}/pw-registry"
    "CLAUDE_CONFIG_DIR=$(agent_claude_dir)"
    "CLAUDE_SECURESTORAGE_CONFIG_DIR=$(agent_claude_dir)"
    "$@")
}

# sandbox_selfcheck: prove the sandbox holds on THIS machine before an agent
# runs under it (fail closed). Needs AGENT_PROFILE, the proxy, the model
# forwarder and QA_STACK_PORT. Every "must fail" probe has a control that must succeed
# outside the sandbox, so a probe that could never succeed proves nothing.
sandbox_selfcheck() {
  local fails="" canary="$QA_WORKTREE/.env.qa-sandbox-canary" lp lpid out
  # Probes run from the agent's own cwd (the worktree): under the read allow-list
  # an arbitrary caller's cwd may be unreadable, and python dies on that.
  sbx() { ( cd "$QA_WORKTREE" && /usr/bin/sandbox-exec -f "$AGENT_PROFILE" "$@" ); }
  tcp() { "$@" /usr/bin/python3 -c 'import socket,sys; socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5).close()' "$PORT" 2>/dev/null; }
  dns() { "$@" /usr/bin/python3 -c 'import socket; socket.getaddrinfo("api.anthropic.com", 443)' >/dev/null 2>&1; }
  echo "QA_SANDBOX_CANARY=1" > "$canary"
  sbx /bin/cat "$canary" >/dev/null 2>&1 && fails="$fails env-file-readable"
  rm -f "$canary"
  [ -e "$ENVVALS" ] && sbx /bin/cat "$ENVVALS" >/dev/null 2>&1 && fails="$fails envvals-readable"
  [ -e "$HOME/.config/gh" ] && sbx /bin/ls "$HOME/.config/gh" >/dev/null 2>&1 && fails="$fails gh-config-readable"
  sbx /usr/bin/curl --noproxy '*' -s -m 5 -o /dev/null https://1.1.1.1 2>/dev/null && fails="$fails direct-egress"
  # DNS: a name that resolves outside must not resolve inside.
  if dns env; then dns sbx && fails="$fails dns"; else fails="$fails dns-probe-inconclusive"; fi
  # The egress proxy's allowlist (its one client is the model forwarder).
  /usr/bin/curl -s -m 10 -o /dev/null --proxy "http://127.0.0.1:$EGRESS_PORT" https://example.com 2>/dev/null && fails="$fails proxy-open"
  /usr/bin/curl -s -m 10 -o /dev/null --proxy "http://127.0.0.1:$EGRESS_PORT" https://api.github.com/zen 2>/dev/null && fails="$fails proxy-allows-github"
  # Strix r10: the agent holds no credential and reaches the model only through
  # the forwarder. The proxy itself is out of its reach.
  if PORT="$EGRESS_PORT" tcp env; then
    PORT="$EGRESS_PORT" tcp sbx && fails="$fails egress-proxy-reachable"
  else fails="$fails egress-probe-inconclusive"; fi
  local code fw="http://127.0.0.1:${MODEL_PORT:-0}" agent_env
  code="$(sbx /usr/bin/curl --noproxy '*' -s -m 10 -o /dev/null -w '%{http_code}' "$fw/api/oauth/profile" 2>/dev/null)"
  [ "$code" = 403 ] || fails="$fails forwarder-open-route($code)"
  # One free request (count_tokens) proves the route and the token: 200, or a
  # 400/404 about the probe's model, means the API accepted the credential.
  code="$(sbx /usr/bin/curl --noproxy '*' -s -m 30 -o /dev/null -w '%{http_code}' -X POST \
    -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
    -d "{\"model\":\"${QA_PROBE_MODEL:-claude-haiku-5-5}\",\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}]}" \
    "$fw/v1/messages/count_tokens" 2>/dev/null)"
  case "$code" in 200|400|404) ;; 401|403) fails="$fails model-auth-rejected($code)" ;; *) fails="$fails model-route-failed($code)" ;; esac
  # The agent's exact environment (build_agent_cmd), printed from inside.
  build_agent_cmd /usr/bin/env
  agent_env="$(cd "$QA_WORKTREE" && "${AGENT_CMD[@]}" 2>/dev/null)"
  case "$agent_env" in
    *CLAUDE_CODE_OAUTH_TOKEN=*) ;;
    *) fails="$fails agent-env-probe-inconclusive" ;;
  esac
  if printf '%s\n' "$agent_env" | LC_ALL=C grep -qE 'sk-ant-|^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_REFRESH_TOKEN)=' \
     || ! printf '%s\n' "$agent_env" | grep -qxF "CLAUDE_CODE_OAUTH_TOKEN=$AGENT_TOKEN_PLACEHOLDER"; then
    fails="$fails agent-env-credential"
  fi
  # ... nor does the forwarder's argv, which the agent can list (its token came on stdin).
  if [ -n "${MODEL_PID:-}" ] && /bin/ps -ww -o command= -p "$MODEL_PID" 2>/dev/null | grep -q model-forwarder; then
    sbx /bin/ps -ww -o command= -p "$MODEL_PID" 2>/dev/null | LC_ALL=C grep -q 'sk-ant-' && fails="$fails forwarder-argv-credential"
  else fails="$fails forwarder-probe-inconclusive"; fi
  [ -e "$(agent_token_path)" ] && sbx /bin/cat "$(agent_token_path)" >/dev/null 2>&1 && fails="$fails token-file-readable"
  # loopback: the stack port connects; any other listener on this Mac does not.
  PORT="$QA_STACK_PORT" tcp sbx || fails="$fails stack-unreachable"
  lp="$QA_HOME/.sandbox/selfcheck.port"; rm -f "$lp"
  /usr/bin/python3 -c 'import socket,sys,time; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(4); open(sys.argv[1],"w").write(str(s.getsockname()[1])); time.sleep(30)' "$lp" &
  lpid=$!
  for _ in $(seq 1 30); do [ -s "$lp" ] && break; sleep 0.1; done
  if PORT="$(cat "$lp" 2>/dev/null)" tcp env; then
    PORT="$(cat "$lp")" tcp sbx && fails="$fails other-loopback-port-open"
  else fails="$fails loopback-probe-inconclusive"; fi
  { kill "$lpid"; wait "$lpid"; } 2>/dev/null; rm -f "$lp"
  sbx /bin/sh -c ': >> "$1"' _ "$RUN_DIR/commits.tsv" 2>/dev/null && fails="$fails scope-writable"
  [ -f "$EGRESS_LOG" ] || fails="$fails audit-log-missing"
  sbx /bin/sh -c ': >> "$1"' _ "$EGRESS_LOG" 2>/dev/null && fails="$fails audit-log-writable"
  sbx /bin/sh -c ': > "$1"' _ "$RUN_DIR/.sandbox-selfcheck" 2>/dev/null || fails="$fails run-dir-readonly"
  rm -f "$RUN_DIR/.sandbox-selfcheck"
  # Writes are an allow-list: the home directory and every PATH directory this
  # user can write outside the sandbox (the control) must be read-only inside it,
  # so no `claude`/`gh` can be planted for the next unsandboxed run.
  local d pw="" probe=".qa-sandbox-probe.$$"
  wprobe() {   # wprobe <dir>: true if the sandbox could create a file in <dir>
    if sbx /bin/sh -c ': > "$1"' _ "$1/$probe" 2>/dev/null; then rm -f "$1/$probe"; return 0; fi
    return 1
  }
  if [ -w "$HOME" ]; then wprobe "$HOME" && fails="$fails home-writable"; else fails="$fails home-probe-inconclusive"; fi
  [ -f "$HOME/.claude.json" ] && sbx /bin/sh -c ': >> "$1"' _ "$HOME/.claude.json" 2>/dev/null && fails="$fails claude-config-writable"
  while IFS= read -r d; do
    case "$d" in /*) ;; *) continue ;; esac
    [ -d "$d" ] && [ -w "$d" ] || continue
    case "$d/" in "$RUN_DIR"/*|"${AGENT_TMP:-$QA_HOME/.t}"/*|"$(agent_claude_dir)"/*) continue ;; esac
    wprobe "$d" && pw="$pw $d"
  done <<EOF
$(printf '%s' "$PATH" | tr ':' '\n')
EOF
  [ -n "$pw" ] && { fails="$fails path-dir-writable"; log "sandbox: PATH dirs writable from inside:$pw"; }
  # Reads under the home directory are an allow-list too. A fresh file in $HOME
  # proves the default (a profile that only names stores fails it), then every
  # per-user store that is readable outside (the control) must not be inside.
  local rcan="$HOME/.qa-sandbox-read-canary.$$" rd=""
  if ( umask 077; echo canary > "$rcan" ) 2>/dev/null && [ "$(cat "$rcan" 2>/dev/null)" = canary ]; then
    sbx /bin/cat "$rcan" >/dev/null 2>&1 && fails="$fails home-readable"
    # A hard link into RUN_DIR must not carry it past the read rules.
    if sbx /bin/ln "$rcan" "$RUN_DIR/.qa-sandbox-hardlink" 2>/dev/null \
       || sbx /bin/cat "$RUN_DIR/.qa-sandbox-hardlink" >/dev/null 2>&1; then fails="$fails home-hardlink-readable"; fi
    rm -f "$RUN_DIR/.qa-sandbox-hardlink"
  else fails="$fails home-read-probe-inconclusive"; fi
  rm -f "$rcan"
  # The same default for the per-user temp/cache dirs and the shared temp dirs.
  local tdir tcan
  for tdir in "$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)" "$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null)" /private/tmp; do
    tdir="${tdir%/}"; [ -n "$tdir" ] && [ -d "$tdir" ] || continue
    tcan="$tdir/.qa-sandbox-read-canary.$$"
    if ( umask 077; echo canary > "$tcan" ) 2>/dev/null; then
      sbx /bin/cat "$tcan" >/dev/null 2>&1 && fails="$fails temp-readable($tdir)"
    else fails="$fails temp-read-probe-inconclusive($tdir)"; fi
    rm -f "$tcan"
  done
  rprobe() {   # rprobe <path...>: each one readable outside must be unreadable inside
    local p c
    for p in "$@"; do
      [ -e "$p" ] || continue
      c=/bin/cat; [ -d "$p" ] && c=/bin/ls
      "$c" "$p" >/dev/null 2>&1 || continue
      sbx "$c" "$p" >/dev/null 2>&1 && rd="$rd $p"
    done
  }
  rprobe "$HOME/.claude" "$HOME"/.claude/* "$HOME/.claude.json" "$HOME/.ssh" "$HOME"/.ssh/* \
    "$HOME/.config" "$HOME"/.config/* "$HOME/.npmrc" "$HOME/.netrc" "$HOME/.git-credentials" \
    "$HOME"/.zsh_history "$HOME"/.bash_history "$HOME"/.zshrc "$HOME"/.zshenv "$HOME"/.zprofile \
    "$HOME"/.bashrc "$HOME"/.bash_profile "$HOME"/.profile "$HOME/.claude-auth" \
    "${CLAUDE_SECURESTORAGE_CONFIG_DIR:-$HOME/.claude}" "$QA_SOURCE_REPO"/.env* \
    "$STATE" "$QA_HOME/launchd.out.log" "$QA_HOME/launchd.err.log"
  # The checkout itself, unless the worktree sits inside it (then that path is the agent's).
  case "$QA_WORKTREE/" in "$QA_SOURCE_REPO"/*) ;; *) rprobe "$QA_SOURCE_REPO" ;; esac
  # Only the toolchain files themselves are allowed, not their directories.
  local k
  for k in claude node; do
    k="$(command -v "$k" 2>/dev/null)" || continue
    k="$(/usr/bin/python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$k" 2>/dev/null)" || continue
    case "$k" in *.js|*.mjs|*.cjs) continue ;; "$HOME"/*) rprobe "$(dirname "$k")" ;; esac   # system dirs stay readable
  done
  [ -n "$rd" ] && { fails="$fails home-store-readable"; log "sandbox: readable from inside:$rd"; }
  # Keychains, the login keychain included (Strix r9): the agent has its own
  # token, so no keychain file is readable or writable from inside, and
  # security(1) -- which opens the keychain db in-process -- cannot read one either.
  local kc="$HOME/Library/Keychains" kr="" kw=0
  if [ -d "$kc" ]; then
    rd=""; rprobe "$kc" "$kc"/* "$kc"/.fl*; kr="$rd"
    if [ -f "$kc/login.keychain-db" ]; then
      /usr/bin/security show-keychain-info "$kc/login.keychain-db" >/dev/null 2>&1 \
        && sbx /usr/bin/security show-keychain-info "$kc/login.keychain-db" >/dev/null 2>&1 && kr="$kr security(1)"
      sbx /bin/sh -c ': >> "$1"' _ "$kc/login.keychain-db" 2>/dev/null && kw=1   # opens for append, writes nothing
    fi
    if sbx /bin/sh -c ': > "$1"' _ "$kc/.qa-sandbox-probe.$$" 2>/dev/null; then kw=1; fi
    rm -f "$kc/.qa-sandbox-probe.$$"
  fi
  [ -n "$kr" ] && { fails="$fails keychain-readable"; log "sandbox: keychain readable from inside:$kr"; }
  [ "$kw" = 1 ] && { fails="$fails keychain-writable"; log "sandbox: keychain writable from inside"; }
  if [ -n "$fails" ]; then log "sandbox selfcheck FAILED:$fails"; return 1; fi
  log "sandbox selfcheck OK (env files + gh config unreadable, no direct egress/DNS, proxy enforces allowlist without GitHub, loopback = stack/forwarder only (egress proxy unreachable), agent env + forwarder argv hold no credential, forwarder refuses non-model routes and the API accepts its token, scope and audit logs read-only, RUN_DIR writable, home + PATH dirs + ~/.claude.json read-only, home directory unreadable outside the allow-list (~/.claude, ~/.ssh, ~/.config, shell history, the checkout and its .env), every keychain incl. login unreadable + unwritable)"
}

# ---------------------------------------------------------------------------
# QA stack egress. The agent administers the stack, and the app exists to call
# destinations its admin supplies (notification webhooks, integrations, ...),
# so the stack must not reach the internet either. After boot, every container
# of the compose project is moved onto an internal-only Docker network (no
# gateway: no outbound TCP/UDP and no external DNS) under its service name; only
# the edge service (Caddy) also keeps the project network, because a published
# port needs a non-internal network. Caddy's upstreams are fixed in its
# Caddyfile and its admin API listens on its own loopback, so nothing the agent
# controls makes it dial out.
# ---------------------------------------------------------------------------
STACK_NET=""
# isolate_stack <project> [edge-service]
isolate_stack() {
  local project="$1" edge="${2:-caddy}" c svc n ids
  STACK_NET="$project-qa-noegress"
  docker network inspect "$STACK_NET" >/dev/null 2>&1 \
    || docker network create --internal --label io.lanternops.qa-sweep=1 "$STACK_NET" >/dev/null || return 1
  [ "$(docker network inspect -f '{{.Internal}}' "$STACK_NET" 2>/dev/null)" = true ] || { log "stack: $STACK_NET is not internal"; return 1; }
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  [ -n "$ids" ] || { log "stack: no containers for project $project"; return 1; }
  for c in $ids; do
    svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c")" || return 1
    if ! docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" | tr ' ' '\n' | grep -qxF "$STACK_NET"; then
      docker network connect --alias "$svc" "$STACK_NET" "$c" >/dev/null || { log "stack: could not attach $svc"; return 1; }
    fi
    [ "$svc" = "$edge" ] && continue
    for n in $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c"); do
      [ "$n" = "$STACK_NET" ] && continue
      docker network disconnect -f "$n" "$c" >/dev/null || { log "stack: could not detach $svc from $n"; return 1; }
    done
  done
}
# stack_isolation_check <project> <probe-service> [edge-service]: fail closed
# unless every non-edge container sits only on internal networks AND a live probe
# from <probe-service> (needs node) can neither resolve an external name nor open
# a TCP connection to an internet address.
stack_isolation_check() {
  local project="$1" probe="$2" edge="${3:-caddy}" fails="" c svc n pc rc
  for c in $(docker ps -aq --filter "label=com.docker.compose.project=$project"); do
    svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c")"
    [ "$svc" = "$edge" ] && continue
    for n in $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c"); do
      [ "$(docker network inspect -f '{{.Internal}}' "$n" 2>/dev/null)" = true ] || fails="$fails $svc-on-$n"
    done
  done
  pc="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$probe" | head -1)"
  if [ -z "$pc" ]; then fails="$fails no-running-$probe"
  else
    # exit 0 = isolated, 10 = external DNS answered, 11 = outbound TCP connected
    docker exec "$pc" node -e '
      const net = require("net"), dns = require("dns");
      let done = false; const fin = (c) => { if (!done) { done = true; process.exit(c); } };
      dns.lookup(process.argv[1], (e) => {
        if (!e) return fin(10);
        const s = net.connect(443, process.argv[2]);
        s.on("connect", () => fin(11)); s.on("error", () => fin(0)); setTimeout(() => fin(0), 5000);
      });' example.com 1.1.1.1 >/dev/null 2>&1
    rc=$?
    case "$rc" in 0) ;; 10) fails="$fails $probe-resolves-external-dns" ;; 11) fails="$fails $probe-reaches-internet" ;;
      *) fails="$fails $probe-probe-failed($rc)" ;; esac
  fi
  if [ -n "$fails" ]; then log "stack isolation check FAILED:$fails"; return 1; fi
  log "stack isolation OK (every service but $edge on internal-only network $STACK_NET; $probe: no external DNS, no outbound TCP)"
}
remove_stack_net() {
  [ -n "$STACK_NET" ] && docker network rm "$STACK_NET" >/dev/null 2>&1
  STACK_NET=""
}


# build_mcp_config <base-url> <src-json> <out-json>: per-run Playwright MCP
# config. The server starts in RUN_DIR/browser (with --ignore-roots its cwd is
# its file workspace) as `node <cli.js>` on the runner's pinned install
# (prewarm_mcp): no npm or npx runs inside the sandbox.
# --allowed-origins is navigation hygiene; the sandbox is the egress control.
# --no-sandbox: Chrome's own renderer sandbox can't be applied inside a Seatbelt
# profile (renderers crash), so the Seatbelt profile confines the whole browser
# instead -- every renderer inherits its file and network limits.
build_mcp_config() {
  local origin node; origin="$(printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*#\1#')"
  node="$(command -v node)" || return 1
  # shellcheck disable=SC2016  # $o/$out/$node/$cli are jq variables; $0/$1/$@ belong to the sh wrapper
  jq --arg o "$origin" --arg out "$RUN_DIR/browser" --arg node "$node" --arg cli "$(mcp_cli_path)" '
    .mcpServers.playwright |= (. + {
      command: "/bin/sh",
      args: (["-c", "cd \"$1\" || exit 1; shift; exec \"$0\" \"$@\"", $node, $out, $cli]
             + (.args | map(select(. != "-y" and (startswith("@playwright/mcp@") | not))))
             + ["--allowed-origins", $o, "--output-dir", $out, "--no-sandbox"])
    })' "$2" > "$3"
}
# The Playwright MCP server, installed by the runner into its own prefix. npm and
# npx need a writable cache, and a writable ~/.npm/_npx is a package the next
# unsandboxed npx would execute, so neither runs inside the sandbox: the agent
# only starts node on this install, which it cannot write.
mcp_cli_path() { printf '%s' "$QA_HOME/mcp/node_modules/@playwright/mcp/cli.js"; }
# prewarm_mcp <src-json>: install the pinned version (outside the sandbox,
# before the agent). True only when exactly that version is in place; a failed
# refresh falls back to an existing install of the same version.
prewarm_mcp() {
  local pkg have; pkg="$(jq -r '.mcpServers.playwright.args[] | select(startswith("@playwright/mcp@"))' "$1" | head -1)"
  [ -n "$pkg" ] || return 1
  ( umask 077; mkdir -p "$QA_HOME/mcp" ) || return 1
  npm install --prefix "$QA_HOME/mcp" --no-save --no-audit --no-fund --ignore-scripts --loglevel=error "$pkg" >/dev/null 2>&1 \
    || log "WARN: could not refresh $pkg; checking the existing install"
  have="$(jq -r '.version // empty' "$QA_HOME/mcp/node_modules/@playwright/mcp/package.json" 2>/dev/null)"
  [ "$have" = "${pkg##*@}" ] && [ -f "$(mcp_cli_path)" ]
}

# ---------------------------------------------------------------------------
# Publishing target: a PRIVATE repo, never the public code repo (2026-11-19)
# ---------------------------------------------------------------------------
# The sweep writes only to QA_REPO (default LanternOps/breeze-qa), and only
# while GitHub says that repo is private. Every runner gh call goes through
# qa_gh, which refuses unless require_private_qa_repo has verified the repo it
# targets. The code repo (QA_CODE_REPO, the checkout's origin) is refused by
# name before GitHub is asked, so a misconfigured QA_REPO cannot point the
# publisher back at it even if it were private. Promoting a finding to the
# public repo is a human step.
QA_REPO_PRIVATE=""
# repo_slug <git-url>: OWNER/NAME of a GitHub remote URL, or nothing.
# Accepts https://[user@]github.com/O/R[.git][/], ssh://git@host[:port]/O/R[.git]
# and scp-style git@host:O/R[.git] (any host: an ssh alias names GitHub too).
# The slug only adds a refusal (QA_REPO == code repo), so a permissive host
# match cannot open anything; the visibility check is the gate.
repo_slug() {
  printf '%s' "$1" | sed -nE \
    -e 's#^https://([^/@[:space:]]+@)?github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/?$#\2#p' \
    -e 's#^ssh://[^/@[:space:]]+@[^/[:space:]]+/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/?$#\1#p' \
    -e 's#^[^/@:[:space:]]+@[^/:[:space:]]+:([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/?$#\1#p' \
    | sed -E 's/\.git$//' | head -1
}
# require_private_qa_repo: QA_REPO_PRIVATE=QA_REPO when, and only when, QA_REPO
# is a well-formed OWNER/NAME that is not the code repo and GitHub reports its
# visibility as exactly PRIVATE. Anything else (PUBLIC, INTERNAL, an error, no
# answer, an unknown code repo) clears it and fails: nothing is published.
require_private_qa_repo() {
  QA_REPO_PRIVATE=""
  local repo="${QA_REPO:-}" code="${QA_CODE_REPO:-}" vis
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { log "publish target: bad QA_REPO; not publishing"; return 1; }
  [[ "$code" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { log "publish target: code repo unknown, cannot prove $repo differs; not publishing"; return 1; }
  if [ "$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$code" | tr '[:upper:]' '[:lower:]')" ]; then
    log "publish target: $repo is the code repo; not publishing"; return 1
  fi
  vis="$(gh repo view "$QA_REPO" --json visibility --jq .visibility 2>/dev/null)" || { log "publish target: could not read the visibility of $repo; not publishing"; return 1; }
  [ "$vis" = PRIVATE ] || { log "publish target: $repo is not private ('$vis'); not publishing"; return 1; }
  QA_REPO_PRIVATE="$repo"
}
# qa_gh <gh args...>: gh against the verified private repo, or a refusal.
qa_gh() {
  if [ -z "$QA_REPO_PRIVATE" ] || [ "$QA_REPO_PRIVATE" != "${QA_REPO:-}" ]; then
    log "REFUSED gh call: the publishing repo is not verified private"; return 1
  fi
  gh -R "$QA_REPO_PRIVATE" "$@"
}
# _jq_str <s>: <s> as a JSON string literal (for a runner constant in a --jq filter).
_jq_str() { jq -n --arg v "$1" '$v'; }
# _issue_number <exact-title>: the open qa-sweep issue with that exact title.
_issue_number() {
  qa_gh issue list --label qa-sweep --state open --limit 1000 --json number,title \
    --jq ".[] | select(.title == $(_jq_str "$1")) | .number" 2>/dev/null | LC_ALL=C grep -E '^[0-9]{1,7}$' | head -1
}
# runner_issue <title> <body-file>: the runner's own findings (boot failure,
# environment drift), one open issue per title, repeats become a comment.
runner_issue() {
  if [ "${QA_DRY_RUN:-0}" = 1 ]; then log "DRY RUN: would file/comment issue: $1 (body: $2)"; return 0; fi
  require_private_qa_repo || { log "REFUSED to publish '$1' (kept locally: $2)"; return 1; }
  body_ok "$2" || { log "REFUSED to publish '$1': body failed secret checks (kept locally: $2)"; return 1; }
  qa_gh label create qa-sweep --color C5DEF5 --description "Found by the scheduled UI QA sweep" >/dev/null 2>&1 || true
  local n; n="$(_issue_number "$1")"
  if [ -n "$n" ]; then qa_gh issue comment "$n" --body-file "$2" >/dev/null && log "commented on #$n: $1"
  else qa_gh issue create --title "$1" --label qa-sweep --body-file "$2" >/dev/null && log "filed: $1"; fi
}

# snapshot_commentable_issues: the issues an outbox `comment` may target, fixed
# before the agent starts = open qa-sweep issues in QA_REPO right now whose title
# starts with the exact ASCII "[UI] " (the agent's own namespace). Runner-owned
# issues ("[QA] ...", the ledger title) are never commentable, and the ledger
# issue's number is denied explicitly too (QA_LEDGER_ISSUE, resolved here and
# never created here). Empty on failure, which rejects every comment.
QA_COMMENTABLE=""; QA_LEDGER_ISSUE=""
snapshot_commentable_issues() {
  local n t list
  QA_LEDGER_ISSUE="$(_issue_number "$LEDGER_TITLE")"
  list="$(qa_gh issue list --label qa-sweep --state open --limit 1000 --json number,title \
            --jq '.[] | "\(.number)\t\(.title)"' 2>/dev/null)"
  QA_COMMENTABLE=" "
  while IFS=$'\t' read -r n t; do
    [[ "$n" =~ ^[0-9]{1,7}$ ]] || continue
    printf '%s' "$t" | LC_ALL=C grep -Eq '^\[UI\] ' || continue
    [ "$n" = "$QA_LEDGER_ISSUE" ] && continue
    QA_COMMENTABLE="$QA_COMMENTABLE$n "
  done <<< "$list"
  [ "$QA_COMMENTABLE" = " " ] && QA_COMMENTABLE=""
  return 0
}
# snapshot_open_issues: RUN_DIR/open-issues.tsv (number<TAB>title, read-only),
# the agent's dedupe list: open qa-sweep issues of the private QA repo, which
# the sweep itself wrote. Titles keep printable ASCII minus markup characters
# (the safe_title set). Nothing from the public repo. Empty on failure.
snapshot_open_issues() {
  local out="$RUN_DIR/open-issues.tsv" num title
  rm -f "$out"
  # shellcheck disable=SC2016  # jq program
  qa_gh issue list --label qa-sweep --state open --limit 1000 --json number,title \
      --jq '.[] | "\(.number)\t\(.title | gsub("[\\t\\r\\n]"; " "))"' 2>/dev/null \
    | while IFS=$'\t' read -r num title; do
        [[ "$num" =~ ^[0-9]{1,7}$ ]] || continue
        printf '%s\t%s\n' "$num" "$(safe_title "$title" | cut -c1-200)"
      done > "$out"
  chmod 0444 "$out"
}

# compute_scope <prev-sha|''> <new-sha>: the merged-since list, from local git
# only (run inside the worktree), written read-only for the agent:
#   RUN_DIR/commits.tsv        sha<TAB>committed-at<TAB>pr ("-" when none)
#   RUN_DIR/changed-files.tsv  sha<TAB>path
# No subject or body reaches a file: a squash subject is the PR's title and its
# body the PR's description, i.e. text anyone can write. The PR number is the
# LAST "(#N)" of the subject (GitHub appends it; earlier ones are references).
# Paths with control characters are dropped. IN_SCOPE (" N N ") is set in shell
# memory, so nothing the agent writes later can widen it. Empty prev = the
# last 3 days of first-parent history.
compute_scope() {
  local prev="$1" new="$2" range sha date subj pr path
  local commits="$RUN_DIR/commits.tsv" files="$RUN_DIR/changed-files.tsv"
  rm -f "$commits" "$files"; : > "$commits"; : > "$files"
  IN_SCOPE=" "
  if [ -n "$prev" ]; then range=("$prev..$new"); else range=(--since='3 days ago' "$new"); fi
  while IFS=$'\t' read -r sha date subj; do
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
    pr="$(printf '%s' "$subj" | sed -nE 's/.*\(#([0-9]{1,7})\)[[:space:]]*$/\1/p')"
    printf '%s\t%s\t%s\n' "$sha" "$date" "${pr:--}" >> "$commits"
    [ -n "$pr" ] && case "$IN_SCOPE" in *" $pr "*) ;; *) IN_SCOPE="$IN_SCOPE$pr " ;; esac
    { git diff --name-only -z "$sha^" "$sha" 2>/dev/null || git diff-tree --no-commit-id --name-only -r -z --root "$sha" 2>/dev/null; } \
      | while IFS= read -r -d '' path; do
          case "$path" in *[[:cntrl:]]*) continue ;; esac
          [ "${#path}" -le 400 ] && printf '%s\t%s\n' "$sha" "$path"
        done >> "$files"
  done < <(git log --first-parent --format='%H%x09%cI%x09%s' "${range[@]}")
  chmod 0444 "$commits" "$files"
}

# ---------------------------------------------------------------------------
# Reading what the agent wrote. RUN_DIR is the agent's to rearrange: any name in
# it may be a symlink, a FIFO or a directory swapped in after a check, and a
# process it left running can do that at any time. So the runner never opens an
# agent path by name with the shell: _agent_io walks from RUN_DIR with
# O_NOFOLLOW on every component (a planted link fails with ELOOP), opens files
# O_NONBLOCK, and accepts only what fstat on the open descriptor says is a
# regular file. Check and use are the same descriptor, so nothing can be swapped
# in between. The runner never writes into RUN_DIR once an agent has started.
# ---------------------------------------------------------------------------
# _agent_io read <run-dir> <rel> <max>    the file to stdout; fails if over <max>
# _agent_io head <run-dir> <rel> <max>    its first <max> bytes to stdout
# _agent_io outbox <run-dir> <dst> <max-entries> <max-bytes>
#     copy outbox/*.json into the runner-owned <dst> (mtime kept), printing one
#     "REJECT ..." line per refused entry; names are shown escaped and cut.
_agent_io() {
  /usr/bin/python3 -I - "$@" <<'PY'
import os, re, stat, sys

NF = os.O_NOFOLLOW | os.O_CLOEXEC

def opendir(root, rel):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | NF)
    for part in [p for p in rel.split("/") if p]:
        if part in (".", ".."):
            raise OSError("bad path")
        nfd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | NF, dir_fd=fd)
        os.close(fd)
        fd = nfd
    return fd

def openreg(dfd, name):
    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | NF, dir_fd=dfd)
    st = os.fstat(fd)
    # A hard link is a second name for a file that lives elsewhere: refuse it
    # like a symlink (the sandbox also refuses linking a file it cannot read).
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        os.close(fd)
        raise OSError("not a regular file")
    return fd, st

def shown(name):
    return ascii(name)[1:-1][:120]

mode, root = sys.argv[1], sys.argv[2]
if mode in ("read", "head"):
    rel, limit = sys.argv[3], int(sys.argv[4])
    parent, _, base = rel.rpartition("/")
    try:
        dfd = opendir(root, parent)
        fd, _st = openreg(dfd, base)
    except OSError:
        sys.exit(2)
    with os.fdopen(fd, "rb") as f:
        data = f.read(limit + 1)
    if len(data) > limit:
        if mode == "read":
            sys.exit(3)
        data = data[:limit]
    sys.stdout.buffer.write(data)
elif mode == "outbox":
    dst, max_n, max_bytes = sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
    try:
        dfd = opendir(root, "outbox")
    except FileNotFoundError:
        sys.exit(0)
    except OSError:
        print("REJECT outbox: not a directory")
        sys.exit(0)
    name_re = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json")
    n = 0
    for name in sorted(os.listdir(dfd)):
        if name.startswith("."):
            continue
        try:
            st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            print("REJECT %s: not a regular file" % shown(name))
            continue
        if not name_re.fullmatch(name):
            print("REJECT (unsafe name): %s" % shown(name))
            continue
        n += 1
        if n > max_n:
            print("REJECT %s: over %d entries" % (name, max_n))
            continue
        try:
            fd, st = openreg(dfd, name)
        except OSError:
            print("REJECT %s: not a regular file" % name)
            continue
        with os.fdopen(fd, "rb") as f:
            data = f.read(max_bytes + 1)
        if len(data) > max_bytes:
            print("REJECT %s: oversized" % name)
            continue
        out = os.path.join(dst, name)
        try:
            ofd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NF, 0o600)
            with os.fdopen(ofd, "wb") as o:
                o.write(data)
            os.utime(out, ns=(st.st_atime_ns, st.st_mtime_ns))
        except OSError:
            print("REJECT %s: copy failed" % name)
else:
    sys.exit(64)
PY
}
# agent_report_present: RUN_DIR/report.md exists as a regular file (not a link).
agent_report_present() { _agent_io head "$RUN_DIR" report.md 0 >/dev/null 2>&1; }
# agent_report_summary: the report's first RESULT: line (first 64 KiB only).
agent_report_summary() {
  _agent_io head "$RUN_DIR" report.md 65536 2>/dev/null | LC_ALL=C grep -a -m1 -E '^RESULT:' | cut -c1-180
}
# runner_fresh_path <path>: true only when nothing at all is at <path> (not even
# a dangling symlink). For the few runner files created in RUN_DIR while an
# agent may still be around; the sandbox also forbids the agent those names.
runner_fresh_path() { [ ! -e "$1" ] && [ ! -L "$1" ]; }

# snapshot_outbox: copy the agent's outbox into a runner-owned directory and
# publish from there (see _agent_io): a symlinked outbox or entry, a FIFO, an
# unsafe name or an oversized file is dropped, and nothing the agent left
# running can swap an entry between validation and use.
snapshot_outbox() {
  PUBLISH_DIR="$QA_HOME/.publish/$RUN_ID"
  rm -rf "$PUBLISH_DIR"; ( umask 077; mkdir -p "$PUBLISH_DIR" ) || return 1
  local line
  while IFS= read -r line; do log "outbox $line"; done \
    < <(_agent_io outbox "$RUN_DIR" "$PUBLISH_DIR" "${QA_MAX_OUTBOX:-300}" 120000)
}

# hosted_verdict <pr>: the result publish_outbox validated and recorded in the
# private ledger for <pr> this run, or nothing. Reads runner memory only.
hosted_verdict() {
  local v
  for v in ${PR_VERDICTS:-}; do [ "${v%%=*}" = "$1" ] && printf '%s\n' "${v#*=}"; done | tail -1
}

# ---------------------------------------------------------------------------
# The private ledger. One open issue titled LEDGER_TITLE in QA_REPO holds the
# sweep's coverage. Its body is written by the runner alone, from runner state
# (STATE: runs and per-PR verdicts), and replaced every run. Per-PR detail goes
# in one comment per run (split when large): a runner header per PR, the
# agent's text fenced. Nothing is written to the public PRs themselves.
# ---------------------------------------------------------------------------
LEDGER_TITLE="QA sweep ledger"
QA_VERDICT_MAX=50000      # one pr_result body; a ledger comment stays under QA_BODY_MAX
QA_LEDGER_CHUNK=55000
# ledger_issue: the open ledger issue's number, creating the issue if missing.
ledger_issue() {
  local n url f
  n="$(_issue_number "$LEDGER_TITLE")"
  if [ -z "$n" ]; then
    f="$(mktemp "${PUBLISH_DIR:-$QA_HOME}/.ledger-init.XXXXXX")" || return 1
    printf 'Scheduled UI QA sweep ledger. The runner rewrites this body after every run.\n' > "$f"
    url="$(qa_gh issue create --title "$LEDGER_TITLE" --label qa-sweep --body-file "$f" 2>/dev/null)"
    rm -f "$f"
    n="$(printf '%s' "$url" | sed -nE 's#.*/issues/([0-9]{1,7})[[:space:]]*$#\1#p')"
  fi
  [[ "$n" =~ ^[0-9]{1,7}$ ]] || return 1
  printf '%s\n' "$n"
}
# _verdict_recorded <pr> <result>: STATE already holds this verdict for <pr> on
# this main SHA (a changed verdict is posted again, with its detail).
_verdict_recorded() {
  [ -f "$STATE" ] && jq -e --arg pr "$1" --arg r "$2" --arg sha "$NEW_SHA" \
    '(.prVerdicts // []) | any(.pr == $pr and .result == $r and .sha == $sha)' "$STATE" >/dev/null 2>&1
}
# _post_verdicts <list-file>: post the queued per-PR sections ("<pr>=<result>
# <section-file>" lines) as comments on the ledger issue, each comment under
# QA_LEDGER_CHUNK bytes and gated again as a whole. PR_VERDICTS gains a PR only
# once the comment holding its section is posted.
_post_verdicts() {
  local list="$1" issue chunk="$PUBLISH_DIR/.ledger-chunk.md" prs="" kv sec size=0 ssize
  [ -s "$list" ] || return 0
  issue="$(ledger_issue)" || { log "ledger: no ledger issue; verdicts not recorded"; return 1; }
  _flush_chunk() {
    [ -n "$prs" ] || return 0
    if body_ok "$chunk" && qa_gh issue comment "$issue" --body-file "$chunk" >/dev/null; then
      PR_VERDICTS="$PR_VERDICTS$prs"
    else
      log "ledger: a verdict comment was refused or failed; its PRs stay unrecorded:$prs"
    fi
    prs=""; size=0
  }
  _start_chunk() {
    printf 'Run %s on main %s: per-PR verdicts from the scheduled UI QA sweep. The agent'"'"'s text is shown verbatim in code blocks.\n' \
      "$RUN_ID" "${NEW_SHA:0:9}" > "$chunk"
    size="$(wc -c < "$chunk" | tr -d ' ')"
  }
  _start_chunk
  while read -r kv sec; do
    ssize="$(wc -c < "$sec" | tr -d ' ')"
    if [ -n "$prs" ] && [ $((size + ssize)) -gt "$QA_LEDGER_CHUNK" ]; then _flush_chunk; _start_chunk; fi
    # Trial-append: a section that would sink the comment it shares is left
    # out on its own (its PR stays unrecorded); the others still post.
    if ! { cat "$chunk" "$sec" > "$chunk.try" && body_ok "$chunk.try"; }; then
      log "ledger: the verdict for PR ${kv%%=*} was refused inside the shared comment; not recorded"; continue
    fi
    mv -f "$chunk.try" "$chunk"; size=$((size + ssize)); prs="$prs $kv"
  done < "$list"
  rm -f "$chunk.try"
  _flush_chunk
}

publish_outbox() {
  PR_VERDICTS=""; PUBLISHED_ISSUES=0
  snapshot_outbox || { log "outbox: could not create the publish directory; nothing published"; return 1; }
  # Re-checked here: a run lasts hours, and the repo must still be private now.
  require_private_qa_repo || { log "outbox: publishing repo not verified private; nothing published (kept in $RUN_DIR)"; return 1; }
  qa_gh label create qa-sweep --color C5DEF5 --description "Found by the scheduled UI QA sweep" >/dev/null 2>&1 || true
  # Rejections name the outbox file, never the agent-written value: a refused
  # field may be the very secret the gate caught.
  local created=0 comments=0 f action title full_title clean_title issue labels bodyf pr result sec
  local max_comments="${QA_MAX_COMMENTS:-20}" vlist="$PUBLISH_DIR/.verdicts"
  : > "$vlist"
  # One verdict per PR: if both phases wrote a pr_result for the same PR (e.g. a
  # BLOCKED from the self-hosted phase, then the hosted check), the newest wins.
  # Only a bare PR number may key the keep file: an entry with a malformed .pr
  # must not shadow the real verdict for that PR (it is rejected below).
  local keep="$PUBLISH_DIR/.pr-keep"
  # shellcheck disable=SC2045  # mtime order needs ls; snapshot_outbox allows [A-Za-z0-9._-] names only
  for f in $(ls -1tr "$PUBLISH_DIR"/*.json 2>/dev/null); do
    [ "$(jq -r '.action // empty' "$f" 2>/dev/null)" = pr_result ] || continue
    pr="$(jq -r '.pr // empty' "$f" 2>/dev/null)"
    [[ "$pr" =~ ^[1-9][0-9]{0,6}$ ]] && printf '%s %s\n' "$pr" "$f"
  done | awk '{last[$1]=$2} END {for (k in last) print last[k]}' > "$keep"
  for f in "$PUBLISH_DIR"/*.json; do
    [ -f "$f" ] || continue
    action="$(jq -r '.action // empty' "$f" 2>/dev/null)"
    if [ "$action" = pr_result ]; then
      pr="$(jq -r '.pr // empty' "$f" 2>/dev/null)"
      [[ "$pr" =~ ^[1-9][0-9]{0,6}$ ]] || { log "outbox REJECT $(basename "$f"): bad pr"; continue; }
      if ! grep -qxF "$f" "$keep"; then
        log "outbox SKIP $(basename "$f"): superseded by a newer verdict for the same PR"; continue
      fi
    fi
    bodyf="$f.body.md"; jq -r '.body // empty' "$f" > "$bodyf" 2>/dev/null
    if ! body_ok "$bodyf"; then
      log "outbox REJECT $(basename "$f"): empty/oversized/secret-like body"; continue
    fi
    if ! fence_text "$bodyf"; then
      log "outbox REJECT $(basename "$f"): could not fence the body"; continue
    fi
    case "$action" in
      create)
        full_title="$(jq -r '.title // empty' "$f" | tr -d '\n')"
        # Same gate as the body, before any cut (a key that straddles column 200
        # must not publish its first half), on the raw title AND on the cleaned
        # one that is published: safe_title deletes characters, which can join
        # the halves of a key the raw check saw apart (AKIA@XXXX...).
        clean_title="$(safe_title "$full_title")"
        if ! text_ok "$full_title" || ! text_ok "$clean_title"; then
          log "outbox REJECT $(basename "$f"): secret-like title"; continue
        fi
        title="$(printf '%s' "$clean_title" | cut -c1-200)"
        # Agent titles must start with the exact ASCII "[UI] ". The "[QA] "
        # namespace (and the ledger title) belongs to the runner: runner_issue
        # dedupes its issues by exact title and the release checklist reads
        # them as ship/block gates, so an agent title can never equal one.
        if [ "$created" -ge "$MAX_NEW_ISSUES" ] || ! printf '%s' "$title" | LC_ALL=C grep -Eq '^\[UI\] .{5,}'; then
          log "outbox REJECT $(basename "$f"): cap reached or bad title"; continue
        fi
        qa_gh issue create --title "$title" --body-file "$bodyf" --label qa-sweep >/dev/null && created=$((created+1)) ;;
      comment)
        issue="$(jq -r '.issue // empty' "$f")"
        [[ "$issue" =~ ^[0-9]{1,7}$ ]] || { log "outbox REJECT $(basename "$f"): bad issue"; continue; }
        # Target must be in the snapshot taken before the agent ran ...
        # The ledger and runner-reserved issues are denied even if listed.
        [ -n "${QA_LEDGER_ISSUE:-}" ] && [ "$issue" = "$QA_LEDGER_ISSUE" ] && { log "outbox REJECT $(basename "$f"): #$issue is the runner-owned ledger"; continue; }
        case "$QA_COMMENTABLE" in *" $issue "*) ;; *) log "outbox REJECT $(basename "$f"): #$issue was not an open qa-sweep issue at run start"; continue ;; esac
        [ "$comments" -lt "$max_comments" ] || { log "outbox REJECT $(basename "$f"): comment cap ($max_comments) reached"; continue; }
        # ... and still open + labelled now.
        labels="$(qa_gh issue view "$issue" --json labels,state --jq 'select(.state=="OPEN")|[.labels[].name]|join(",")' 2>/dev/null)"
        case ",$labels," in *,qa-sweep,*) qa_gh issue comment "$issue" --body-file "$bodyf" >/dev/null && comments=$((comments+1)) ;;
          *) log "outbox REJECT $(basename "$f"): #$issue is not an open qa-sweep issue" ;; esac ;;
      pr_result)
        # $pr was validated (bare number, newest for its PR) above.
        result="$(jq -r '.result // empty' "$f")"
        # IN_SCOPE is shell memory captured before the agent ran; commits.tsv is never re-read.
        case "$IN_SCOPE" in *" $pr "*) ;; *) log "outbox REJECT $(basename "$f"): PR $pr not in this run's commit range"; continue ;; esac
        case "$result" in PASS|PARTIAL|FAIL|BLOCKED|NO_UI) ;; *) log "outbox REJECT $(basename "$f"): bad result"; continue ;; esac
        [ "$(wc -c < "$bodyf" | tr -d ' ')" -le "$QA_VERDICT_MAX" ] || { log "outbox REJECT $(basename "$f"): verdict body over $QA_VERDICT_MAX bytes"; continue; }
        # One record per PR per main SHA (a re-run of the same range doesn't double-post).
        if _verdict_recorded "$pr" "$result"; then
          log "outbox SKIP $(basename "$f"): PR $pr already recorded for main ${NEW_SHA:0:9}"; PR_VERDICTS="$PR_VERDICTS $pr=$result"; continue
        fi
        # "PR N", never "#N": in the QA repo a #N would point at its own issue N.
        sec="$f.section.md"
        { printf '\n### PR %s: %s\n' "$pr" "$result"
          [ "$result" = NO_UI ] || { echo; cat "$bodyf"; }
        } > "$sec"
        # Gated again with the runner's heading: "### PR N: RESULT" puts a ":"
        # before any "@" in the body. Refused here, alone, so it cannot sink the
        # verdict comment its neighbours share.
        body_ok "$sec" || { log "outbox REJECT $(basename "$f"): verdict refused under its heading (secret gate)"; continue; }
        printf '%s=%s %s\n' "$pr" "$result" "$sec" >> "$vlist" ;;
      *) log "outbox REJECT $(basename "$f"): unknown action" ;;
    esac
  done
  _post_verdicts "$vlist"
  PUBLISHED_ISSUES="$created"
  log "outbox: $created issue(s) created, $comments comment(s), $(printf '%s' "$PR_VERDICTS" | wc -w | tr -d ' ') PR verdict(s) recorded in the private ledger"
}

# record_run_ledger <report-summary> <completed 0|1>: add this run and the PR
# verdicts publish_outbox recorded (PR_VERDICTS) to STATE, then rewrite the
# ledger issue's body from STATE. Only runner values are written: the RESULT
# word is taken from the agent's summary line when it is exactly PASS, ISSUES
# or BLOCKED, otherwise "-"; a run that did not complete is INCOMPLETE.
record_run_ledger() {
  local word=INCOMPLETE tmp body issue open
  if [ "$2" = 1 ]; then
    word="$(printf '%s\n' "$1" | head -1 | LC_ALL=C sed -nE 's/^RESULT: (PASS|ISSUES|BLOCKED)([^A-Za-z0-9_].*)?$/\1/p')"
    word="${word:--}"
  fi
  open="$(printf '%s' "${QA_COMMENTABLE:-}" | wc -w | tr -d ' ')"
  tmp="$(mktemp "$QA_HOME/.state.XXXXXX")" || return 1
  # shellcheck disable=SC2016  # jq program
  jq -n --slurpfile old <(cat "$STATE" 2>/dev/null || echo '{}') \
     --arg run "$RUN_ID" --arg sha "$NEW_SHA" --arg prev "${PREV_SHA:-}" --arg slice "${SLICE:-0}" \
     --arg result "$word" --arg verdicts "${PR_VERDICTS:-}" --argjson issues "${PUBLISHED_ISSUES:-0}" \
     --argjson open "${open:-0}" --argjson completed "$2" \
     '($old[0] // {}) as $o
      | [$verdicts | splits(" +") | select(test("^[0-9]+=[A-Z_]+$")) | split("=") | {pr: .[0], result: .[1], sha: $sha, run: $run}] as $nv
      | ($nv + ($o.prVerdicts // [])) as $all
      | (reduce $all[] as $v ({seen: {}, out: []};
           if .seen[$v.pr] then . else .seen[$v.pr] = true | .out += [$v] end) | .out[:400]) as $pv
      | ([{run: $run, sha: $sha, prev: $prev, slice: $slice, result: $result,
           prs: ($nv | length), issues: $issues, open: $open, completed: ($completed == 1)}] + ($o.runs // []))[:20] as $runs
      | $o + {prVerdicts: $pv, runs: $runs}' > "$tmp" && mv "$tmp" "$STATE" || { rm -f "$tmp"; return 1; }
  require_private_qa_repo || { log "ledger: publishing repo not verified private; ledger not updated"; return 1; }
  body="$QA_HOME/.ledger-body.md"
  # shellcheck disable=SC2016  # jq program
  jq -r '
    def s9: if . == null or . == "" then "-" else .[0:9] end;
    ((.runs // []) | map(select(.completed)) | first) as $last
    | "Scheduled UI QA sweep ledger. The runner rewrites this body after every run;",
      "per-PR detail is in the run comments below. Findings stay in this private repo:",
      "promoting one to the public repo is a human step.",
      "",
      (if $last then "Coverage: swept through main \($last.sha | s9) (\($last.run)) | open qa-sweep issues at run start: \($last.open)"
       else "Coverage: no completed sweep yet" end),
      "",
      "## Recent runs (newest first)",
      "",
      "| run | main | from | slice | result | PRs with a verdict | issues filed |",
      "|---|---|---|---|---|---|---|",
      ((.runs // [])[] | "| \(.run) | \(.sha | s9) | \(.prev | s9) | \(.slice) | \(.result) | \(.prs) | \(.issues) |"),
      "",
      "## Per-PR verdicts (newest first, latest per PR)",
      "",
      "```text",
      ((.prVerdicts // [])[] | "pr=\(.pr) result=\(.result) main=\(.sha | s9) run=\(.run)"),
      "```"' "$STATE" > "$body" || return 1
  body_ok "$body" || { log "ledger: body failed the secret gate; not updated (kept: $body)"; return 1; }
  issue="$(ledger_issue)" || { log "ledger: no ledger issue; not updated"; return 1; }
  qa_gh issue edit "$issue" --body-file "$body" >/dev/null && log "ledger updated (issue $issue)"
}
