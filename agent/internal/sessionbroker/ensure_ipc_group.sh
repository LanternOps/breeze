# shellcheck shell=sh
# `local` is not POSIX but every shell this runs under has it: macOS /bin/sh
# (bash), bash, and dash (/bin/sh in the Linux CI job that tests this file).
# shellcheck disable=SC3043
#
# ensure_breeze_group: make sure the local `breeze` group — owner of the agent's
# 0660 IPC socket — exists AND carries a numeric PrimaryGroupID.
#
# This file is the single source of truth for that rule on macOS. It is used by:
#   - the daemon, on every start, and `breeze-agent service install`
#     (go:embed'ed into sessionbroker and run under /bin/sh by EnsureIPCGroup);
#   - the .pkg postinstall (installer/macos/build-pkg.sh copies it next to the
#     postinstall script, which sources it under bash `set -e`);
#   - scripts/install/install-darwin.sh (sources it under bash `set -euo pipefail`).
# Keep it POSIX sh, free of `set` changes that would leak into a sourcing
# script, and free of pipelines whose exit status matters (pipefail).
#
# #7829: a `breeze` record without a PrimaryGroupID (left by an earlier failed
# install) used to pass as "already exists" forever, so the daemon could never
# resolve the group and agent.sock stayed root:wheel. `dscl . -read <rec> <attr>`
# for a key the record lacks prints "No such key: <attr>" and still exits 0, so
# the GID has to be parsed — the exit status cannot tell "has one" from "none".
#
# Never touches a record that already has a numeric GID.

# breeze_group_gid prints the breeze group's numeric PrimaryGroupID, or nothing
# when the group or the attribute is missing or not a number. Always returns 0.
breeze_group_gid() {
    local _bg_out
    _bg_out=$(dscl . -read /Groups/breeze PrimaryGroupID 2>/dev/null) || _bg_out=""
    # Word-split on purpose: covers both "PrimaryGroupID: 350" and dscl's
    # folded form "PrimaryGroupID:\n 350".
    # shellcheck disable=SC2086
    set -- $_bg_out
    if [ "$#" -ge 2 ] && [ "$1" = "PrimaryGroupID:" ]; then
        case "$2" in
            '' | *[!0-9]*) ;;
            *) printf '%s\n' "$2" ;;
        esac
    fi
    return 0
}

# ensure_breeze_group creates the group, or repairs one without a valid GID,
# using the first GID in the local system range 350-499 no other group holds.
# Returns non-zero, with the reason on stderr, when it cannot.
ensure_breeze_group() {
    local _bg_existing _bg_used _bg_gid
    _bg_existing=0
    if dscl . -read /Groups/breeze >/dev/null 2>&1; then
        if [ -n "$(breeze_group_gid)" ]; then
            return 0
        fi
        _bg_existing=1
    fi

    if ! _bg_used=$(dscl . -list /Groups PrimaryGroupID); then
        echo "Error: could not list local group IDs; cannot ensure the breeze group" >&2
        return 1
    fi
    # One space-delimited line ("name gid name gid ..."); a GID is free when it
    # does not appear as a whole word.
    # shellcheck disable=SC2086
    _bg_used=" $(printf '%s ' $_bg_used)"

    _bg_gid=350
    while [ "$_bg_gid" -le 499 ]; do
        case "$_bg_used" in
            *" $_bg_gid "*)
                _bg_gid=$((_bg_gid + 1))
                continue
                ;;
        esac
        if [ "$_bg_existing" -eq 0 ]; then
            dscl . -create /Groups/breeze || {
                echo "Error: could not create the breeze group" >&2
                return 1
            }
        fi
        dscl . -create /Groups/breeze PrimaryGroupID "$_bg_gid" || {
            echo "Error: could not set PrimaryGroupID $_bg_gid on the breeze group" >&2
            return 1
        }
        # Re-read rather than trust dscl's exit status.
        if [ "$(breeze_group_gid)" != "$_bg_gid" ]; then
            echo "Error: breeze group PrimaryGroupID did not take (wanted $_bg_gid)" >&2
            return 1
        fi
        if [ "$_bg_existing" -eq 1 ]; then
            echo "Repaired breeze group: it had no valid PrimaryGroupID; assigned gid $_bg_gid"
        else
            echo "Created breeze group for IPC socket access (gid $_bg_gid)"
        fi
        return 0
    done

    echo "Error: no free local system GID (350-499) available for the breeze group" >&2
    return 1
}
