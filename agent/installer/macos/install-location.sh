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

# Desktop-helper LaunchAgents (#10868). Unlike the daemons above, a helper
# that will not load must not fail the install: the caller warns and carries
# on, and for the per-user helper the agent's post-update revival
# (kickstartDarwinDesktopHelpers) bootstraps one it finds unloaded.
# launchctl's own stderr is always printed, never discarded: it is the only
# record of why a helper is missing.

# load_launch_agent <domain> <label> <plist>: bootstrap a LaunchAgent into
# <domain> (gui/<uid>, or loginwindow when nobody is logged in). A label that
# is already loaded (the agent's post-update revival loaded it first, or an
# old instance never left) answers bootstrap with EIO 5; kickstart -k then
# succeeds and restarts it onto the binary just installed, and a successful
# kickstart -k is itself proof the label is loaded. EIO 5 on a label
# kickstart cannot find is launchd still settling, so the bootstrap is
# retried once after a short wait.
#
# Not for the loginwindow domain while a user is logged in: there every
# launchctl operation (print, bootstrap, kickstart) answers exit 1
# "Operation not permitted", even as root (lab mini, macOS 15.8.1).
load_launch_agent() {
    local domain="$1" label="$2" plist="$3" out="" rc=0 kout="" krc=0 attempt=1
    while :; do
        rc=0
        out=$(launchctl bootstrap "$domain" "$plist" 2>&1) || rc=$?
        if [ "$rc" -eq 0 ]; then
            echo "Loaded $label into $domain"
            return 0
        fi
        echo "launchctl bootstrap $domain $plist exited $rc: $out"
        krc=0
        kout=$(launchctl kickstart -k "$domain/$label" 2>&1) || krc=$?
        if [ "$krc" -eq 0 ]; then
            echo "$domain/$label was already loaded; restarted it onto the installed binary"
            return 0
        fi
        echo "launchctl kickstart -k $domain/$label exited $krc: $kout"
        if [ "$rc" -ne 5 ] || [ "$attempt" -ge 2 ]; then
            break
        fi
        attempt=2
        sleep 1
    done
    {
        echo "Warning: could not load $label into $domain: $out"
        echo "  Remote desktop for this session stays unavailable until it is loaded at the next login, or, in Terminal:"
        echo "  sudo launchctl bootstrap $domain $plist"
    } >&2
    return 1
}

# reload_launch_agent <domain> <label> <plist>: boot out the running instance
# so the installed binary and plist take effect, then load it again.
# `launchctl bootout` returns before launchd has finished tearing the old
# instance down, and a bootstrap issued in that window fails with
# "Bootstrap failed: 5: Input/output error" (the lab mini, #10868), so wait
# (bounded, short polls) for the label to leave before bootstrapping. An
# idle helper took 2.4-2.9 s to leave on the lab mini; launchd gives a slow
# exit (a helper mid-session) up to 20 s, so the wait allows 15 s. Used for
# gui/<uid> domains, where `launchctl print` reports the label.
reload_launch_agent() {
    local domain="$1" label="$2" plist="$3" out="" rc=0 polls=0
    out=$(launchctl bootout "$domain/$label" 2>&1) || rc=$?
    if [ "$rc" -ne 0 ]; then
        # Expected on a first install, where nothing was loaded.
        echo "launchctl bootout $domain/$label exited $rc: $out"
    fi
    while launchctl print "$domain/$label" >/dev/null 2>&1; do
        if [ "$polls" -ge 30 ]; then
            echo "Warning: $domain/$label is still loaded 15s after bootout; loading anyway" >&2
            break
        fi
        polls=$((polls + 1))
        sleep 0.5
    done
    load_launch_agent "$domain" "$label" "$plist"
}

# Network-isolation recovery (#10099). The recovery binary is a separate,
# versioned, root-only executable the LaunchDaemons run when the agent cannot
# (spec §3.6). Both functions do nothing unless the pkg staged a recovery binary
# in pkg-staging/isolation-recovery/<version>/.
#
# postinstall calls them under `if !`, which turns `set -e` off inside them, so
# every step that can fail stops the function itself.

# stage_isolation_recovery <src> <tmp-dir>: build a complete version directory.
stage_isolation_recovery() {
    mkdir "$2" &&
        cp "$1" "$2/breeze-isolation-recovery" &&
        chown -R root:wheel "$2" &&
        chmod 0755 "$2" "$2/breeze-isolation-recovery" || return 1
    xattr -d com.apple.quarantine "$2/breeze-isolation-recovery" 2>/dev/null || true
}

# install_isolation_recovery <staged-dir> <install-root>: copy each staged
# <version>/breeze-isolation-recovery to <install-root>/<version>/ as
# root:wheel 0755, and print the installed path. An existing version
# directory is never touched: an unresolved episode's jobs run the file inside
# it, and the agent adopts new versions only while nothing is isolated.
install_isolation_recovery() {
    local staged="$1" root="$2" src version dest tmp installed=""
    for src in "$staged"/*/breeze-isolation-recovery; do
        [ -f "$src" ] || continue
        version=$(basename "$(dirname "$src")") || return 1
        case "$version" in
            "" | .* | *[!0-9A-Za-z.+-]*)
                echo "Refusing isolation recovery version '$version': not a version" >&2
                return 1
                ;;
        esac
        if [ -L "$root" ] || { [ -e "$root" ] && [ ! -d "$root" ]; }; then
            echo "Refusing to install into $root: not a real directory" >&2
            return 1
        fi
        mkdir -p "$root" && chown root:wheel "$root" && chmod 0755 "$root" || return 1
        dest="$root/$version"
        if [ -e "$dest" ] || [ -L "$dest" ]; then
            if [ -L "$dest" ] || [ ! -f "$dest/breeze-isolation-recovery" ]; then
                echo "Refusing to use $dest: it holds no recovery binary" >&2
                return 1
            fi
            echo "Isolation recovery $version is already installed; leaving it untouched" >&2
        else
            tmp="$root/.$version.pkg-new"
            rm -rf "$tmp" || return 1
            if ! stage_isolation_recovery "$src" "$tmp" || ! mv "$tmp" "$dest"; then
                rm -rf "$tmp"
                echo "Could not install isolation recovery $version" >&2
                return 1
            fi
            echo "Installed isolation recovery $version" >&2
        fi
        installed="$dest/breeze-isolation-recovery"
    done
    printf '%s\n' "$installed"
}

# load_isolation_recovery_daemon <recovery> <template> <plist> <data-dir>: on
# the first install only, render the com.breeze.isolation LaunchDaemon for
# <recovery> and load it into the system domain. An existing plist is left
# alone: it may be pinned to an unresolved episode's recovery path.
load_isolation_recovery_daemon() {
    local recovery="$1" template="$2" plist="$3" data_dir="$4" tmp
    [ -n "$recovery" ] || return 0
    if [ -e "$plist" ] || [ -L "$plist" ]; then
        echo "The isolation recovery daemon is already installed; leaving it untouched"
        return 0
    fi
    if [ ! -f "$template" ]; then
        echo "Warning: no isolation recovery daemon template at $template" >&2
        return 1
    fi
    # Both values are installer-chosen paths; '|', '&' and '\' would break the
    # substitution, so refuse them rather than escape them.
    case "$recovery$data_dir" in
        *'|'* | *'&'* | *\\*)
            echo "Refusing to render the isolation recovery daemon for $recovery" >&2
            return 1
            ;;
    esac
    # A plist left behind would read as "already installed" on every later
    # install, so a failure at any step removes it.
    tmp="$plist.pkg-new"
    if ! sed -e "s|__RECOVERY_PATH__|$recovery|g" -e "s|__DATA_DIR__|$data_dir|g" "$template" > "$tmp" ||
        [ ! -s "$tmp" ] || ! chown root:wheel "$tmp" || ! chmod 0644 "$tmp" || ! mv -f "$tmp" "$plist"; then
        rm -f "$tmp"
        echo "Warning: could not write $plist" >&2
        return 1
    fi
    if ! bootstrap_system_daemon com.breeze.isolation "$plist"; then
        rm -f "$plist"
        return 1
    fi
}
