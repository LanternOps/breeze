# shellcheck shell=bash
# Breeze Agent macOS install-location rules, sourced by the .pkg postinstall.
#
# Which directory the root daemons (breeze-agent, breeze-watchdog) and
# breeze-backup live in (#7211):
#
#   1. Already in TRUSTED_BIN_DIR (/Library/Breeze/bin)  -> stay there.
#      A running agent moved it there, or an earlier pkg / install script put
#      it there. Moving it back would cost Full Disk Access a second time.
#   2. Otherwise, LEGACY_BIN_DIR (/usr/local/bin) if it is safe for a root
#      daemon: it and every directory above it are root-owned, real (not
#      symlinked) directories that group and other cannot write.
#      Upgrades keep the path macOS keyed the Full Disk Access grant to.
#   3. Otherwise TRUSTED_BIN_DIR (e.g. Homebrew on Intel chowned
#      /usr/local/bin to an admin user).
#
# The running agent applies the same rules on start
# (agent/internal/macrelocate, securefs.VerifyTrustedExecutablePathChain), so
# a pkg install and the next agent start always agree and never move the
# binary back and forth.
#
# POSIX tools only (ls -ldn, sed -i.bak), so the Go tests in
# agent/installer can exercise these functions on the Linux CI runners.

LEGACY_BIN_DIR="/usr/local/bin"
TRUSTED_BIN_DIR="/Library/Breeze/bin"

# path_is_root_safe <path>: an existing, non-symlink directory owned by uid 0
# with no group or other write bit.
path_is_root_safe() {
    local p="$1" line
    [ -L "$p" ] && return 1
    [ -d "$p" ] || return 1
    line=$(ls -ldn "$p" 2>/dev/null) || return 1
    ls_line_is_root_safe "$line"
}

# ls_line_is_root_safe <ls -ldn line>: numeric owner (field 3) is 0 and the
# mode string (field 1) has no group-write (6th char) or other-write (9th
# char) bit. A trailing @ or + (macOS xattr/ACL markers) does not matter.
ls_line_is_root_safe() {
    local perms uid
    perms=$(printf '%s\n' "$1" | awk '{print $1}')
    uid=$(printf '%s\n' "$1" | awk '{print $3}')
    [ "$uid" = "0" ] || return 1
    [ "${#perms}" -ge 10 ] || return 1
    case "$perms" in
        ?????w* | ????????w*) return 1 ;;
    esac
    return 0
}

# legacy_dir_is_safe <dir>: every existing component from <dir> up to / is
# path_is_root_safe. Components that do not exist yet are skipped: a fresh
# Mac may have no /usr/local/bin, and the installer creates it root:wheel
# 0755 under whatever ancestors do exist.
legacy_dir_is_safe() {
    local p="${1%/}"
    [ -n "$p" ] || p="/"
    while :; do
        if [ -e "$p" ] || [ -L "$p" ]; then
            path_is_root_safe "$p" || return 1
        fi
        [ "$p" = "/" ] && return 0
        p=$(dirname "$p")
    done
}

# choose_bin_dir: print the directory the daemon binaries go in (rules above).
choose_bin_dir() {
    if [ -f "$TRUSTED_BIN_DIR/breeze-agent" ] && [ ! -L "$TRUSTED_BIN_DIR/breeze-agent" ]; then
        echo "$TRUSTED_BIN_DIR"
    elif legacy_dir_is_safe "$LEGACY_BIN_DIR"; then
        echo "$LEGACY_BIN_DIR"
    else
        echo "$TRUSTED_BIN_DIR"
    fi
}

# point_plist_at <plist> <from-dir> <to-dir> <binary-name>: repoint the
# plist's ProgramArguments entry for <binary-name> from one directory to the
# other. Matches the whole <string> element so nothing else changes.
point_plist_at() {
    local plist="$1" from="$2" to="$3" name="$4"
    sed -i.bak "s|<string>$from/$name</string>|<string>$to/$name</string>|" "$plist"
    rm -f "$plist.bak"
}

# ensure_trusted_bin_dir: create TRUSTED_BIN_DIR and its parent as real
# root:wheel 0755 directories, refusing a symlink or a non-directory.
ensure_trusted_bin_dir() {
    local d
    for d in "$(dirname "$TRUSTED_BIN_DIR")" "$TRUSTED_BIN_DIR"; do
        if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then
            echo "Refusing to install into $d: not a real directory" >&2
            return 1
        fi
        mkdir -p "$d"
        chown root:wheel "$d"
        chmod 0755 "$d"
    done
}

# install_binary <src> <dst>: copy src to dst as root:wheel 0755 via a
# same-directory temp file, so dst is never observed half-written.
install_binary() {
    local src="$1" dst="$2" tmp
    tmp="$(dirname "$dst")/.$(basename "$dst").pkg-new"
    rm -f "$tmp"
    cp "$src" "$tmp"
    chown root:wheel "$tmp"
    chmod 0755 "$tmp"
    # Notarized, but a raw Mach-O cannot have the ticket stapled.
    xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$dst"
}

# explain_unsafe_legacy_dir <dir>: tell the operator, in the install log, why
# choose_bin_dir passed over <dir> and how to get it back. The fallback itself
# is supported; this only replaces a silent surprise with an explanation
# (#7831). Always succeeds.
explain_unsafe_legacy_dir() {
    local p="${1%/}" line why=""
    [ -n "$p" ] || p="/"
    while :; do
        if [ -L "$p" ]; then
            why="$p is a symlink"
            break
        fi
        if [ -e "$p" ]; then
            line=$(ls -ldn "$p" 2>/dev/null) || line=""
            if ! ls_line_is_root_safe "$line"; then
                why="$p has owner uid $(printf '%s\n' "$line" | awk '{print $3}') and mode $(printf '%s\n' "$line" | awk '{print $1}')"
                break
            fi
        fi
        [ "$p" = "/" ] && break
        p=$(dirname "$p")
    done
    echo "Note: $1 is not safe for root daemons: ${why:-it failed the root-ownership check} (it must be a real directory owned by root and not writable by group or others)."
    echo "Installing the agent and watchdog to $TRUSTED_BIN_DIR instead. This is supported."
    # A symlinked component has no safe one-line fix, and with no component
    # named there is nothing specific to change.
    case "$why" in
        *" has owner uid "*)
            echo "To install to $1 instead, before a fresh install: sudo chown root:wheel $p && sudo chmod go-w $p"
            ;;
    esac
    echo "(Homebrew on Intel Macs owns /usr/local/bin, and changing that can break brew. Do not chown /usr/local itself: macOS restricts it.)"
}

# bootstrap_system_daemon <label> <plist>: load a LaunchDaemon so it is
# running, tolerating the states that make `launchctl bootstrap` answer
# "Bootstrap failed: 5: Input/output error" (#7831):
#   - the label is disabled in launchd's override database (self_uninstall
#     disables it, #2796); installing is a request to run it, so enable it;
#   - a bootout returned while the old instance is still being torn down;
#     wait for the label to leave launchd before bootstrapping;
#   - something else loaded the label first (the watchdog's recovery does
#     exactly that when it finds no agent); a loaded label that kickstart
#     confirms is running is success, not failure.
# A genuine failure is retried, then reported with recovery steps; returns 1.
bootstrap_system_daemon() {
    local label="$1" plist="$2" out="" tries=0 stale=0
    out=$(launchctl enable "system/$label" 2>&1) ||
        echo "Warning: could not enable system/$label ($out); trying to load it anyway" >&2
    launchctl bootout "system/$label" 2>/dev/null || true
    while launchctl print "system/$label" >/dev/null 2>&1; do
        tries=$((tries + 1))
        if [ "$tries" -ge 20 ]; then
            echo "Warning: system/$label is still loaded ${tries}s after bootout" >&2
            stale=1
            break
        fi
        sleep 1
    done
    tries=0
    while :; do
        if out=$(launchctl bootstrap system "$plist" 2>&1); then
            return 0
        fi
        # Only a label that left launchd after our bootout can have been
        # re-loaded by someone else from the plist on disk. If the old
        # instance never left, the loaded job is the OLD definition (perhaps
        # still naming the pre-relocation path), so it is not success.
        # Judge "running" from launchd's own state, not kickstart's exit code.
        if [ "$stale" -eq 0 ] && launchctl print "system/$label" >/dev/null 2>&1; then
            launchctl kickstart "system/$label" >/dev/null 2>&1 || true
            sleep 1
            case "$(launchctl print "system/$label" 2>/dev/null)" in
                *"state = running"*)
                    echo "launchctl bootstrap reported '$out', but $label was already loaded and is running; continuing"
                    return 0
                    ;;
            esac
        fi
        tries=$((tries + 1))
        [ "$tries" -ge 3 ] && break
        sleep 1
    done
    {
        echo "Error: launchd would not load $label from $plist: $out"
        echo "  Plist: $(ls -ln "$plist" 2>&1 || true)"
        if command -v plutil >/dev/null 2>&1; then
            echo "  Lint:  $(plutil -lint "$plist" 2>&1 || true)"
        fi
        echo "  Override: $(launchctl print-disabled system 2>/dev/null | grep -F "\"$label\"" || echo 'not disabled')"
        echo "Recovery, in Terminal:"
        echo "  sudo launchctl enable system/$label"
        echo "  sudo launchctl bootstrap system $plist"
        echo "If that still fails, send /var/log/install.log and the output of 'sudo launchctl print system/$label' to support."
    } >&2
    return 1
}
