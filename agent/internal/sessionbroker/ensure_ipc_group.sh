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
# Never touches a record that already has a numeric GID, and never writes when
# the record cannot be read.

# breeze_group_read prints one word describing the breeze record:
#   absent  no such record (dscl's eDSRecordNotFound)
#   <n>     its numeric PrimaryGroupID
#   nogid   the record exists but PrimaryGroupID is missing or not a number
# Any other read failure (wedged opendirectoryd, timeout, permissions) returns
# 1 with dscl's output on stderr, so a transient error is never mistaken for
# "absent" or "nogid" — which would overwrite a valid GID.
breeze_group_read() {
    local _bg_out _bg_val
    if ! _bg_out=$(dscl . -read /Groups/breeze PrimaryGroupID 2>&1); then
        case "$_bg_out" in
            *eDSRecordNotFound*)
                echo absent
                return 0
                ;;
        esac
        printf '%s\n' "$_bg_out" >&2
        return 1
    fi
    # Handles "PrimaryGroupID: 350" and dscl's folded "PrimaryGroupID:\n 350";
    # "No such key: PrimaryGroupID" (which exits 0) yields nothing. awk rather
    # than word splitting, so nothing is glob-expanded.
    _bg_val=$(printf '%s\n' "$_bg_out" | awk '
        $1 == "PrimaryGroupID:" { if (NF >= 2) print $2; else if ((getline) > 0) print $1; exit }')
    case "$_bg_val" in
        '' | *[!0-9]*) echo nogid ;;
        *) printf '%s\n' "$_bg_val" ;;
    esac
    return 0
}

# ensure_breeze_group creates the group, or repairs one without a valid GID,
# using the first GID in the local system range 350-499 no other group holds.
# Returns non-zero, with the reason on stderr, when it cannot — including when
# the record cannot be read, in which case nothing is written.
ensure_breeze_group() {
    local _bg_state _bg_existing _bg_list _bg_used _bg_gid
    if ! _bg_state=$(breeze_group_read); then
        echo "Error: could not read the breeze group; leaving it untouched" >&2
        return 1
    fi
    case "$_bg_state" in
        absent) _bg_existing=0 ;;
        nogid) _bg_existing=1 ;;
        *) return 0 ;; # numeric GID: never touched
    esac

    if ! _bg_list=$(dscl . -list /Groups PrimaryGroupID); then
        echo "Error: could not list local group IDs; cannot ensure the breeze group" >&2
        return 1
    fi
    # The listing is a second, independent read of the record. If it shows
    # breeze holding a numeric GID, the -read above misread it (a spurious
    # not-found, or empty output); writing now would move a valid group to a
    # new GID and orphan everything owned by the old one.
    case "$(printf '%s\n' "$_bg_list" | awk '$1 == "breeze" && $2 ~ /^[0-9]+$/ { print "has-gid"; exit }')" in
        has-gid)
            echo "Error: inconsistent directory read: the group listing shows breeze with a GID but reading it returned '$_bg_state'; leaving it untouched" >&2
            return 1
            ;;
    esac
    # One space-delimited line of every assigned GID; a candidate is free when
    # it does not appear there as a whole word.
    _bg_used=" $(printf '%s\n' "$_bg_list" | awk '{ printf "%s ", $2 }')"

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
        # Re-read rather than trust dscl's exit status. A failing re-read
        # prints dscl's own error, so the cause is not hidden behind the
        # message below.
        if [ "$(breeze_group_read)" != "$_bg_gid" ]; then
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
