#!/bin/bash
# Breeze Agent macOS minimum-OS check. Sourced by the .pkg preinstall from its
# own directory (build-pkg.sh copies it next to the scripts); never executed.
# Must stay compatible with the bash 3.2 that ships in /bin/bash.
#
#   breeze_os_floor_check <current> <minimum>
#     returns 0  allow    (current >= minimum)
#     returns 1  refuse   (current <  minimum)
#     returns 2  unknown  (either value empty, malformed, or the 10.16
#                          SYSTEM_VERSION_COMPAT value) - callers continue
#
# Versions are compared as numeric tuples, missing parts = 0, so 13 == 13.0 ==
# 13.0.0. Format: ^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$ (agent/platform-floors.json).

_breeze_os_floor_valid() {
    case "$1" in
        '' | *[!0-9.]* | .* | *. | *..*) return 1 ;;
    esac
    local IFS=.
    # shellcheck disable=SC2086
    set -- $1
    [ "$#" -le 3 ] || return 1
    local part
    for part in "$@"; do
        [ "${#part}" -ge 1 ] && [ "${#part}" -le 3 ] || return 1
    done
    return 0
}

breeze_os_floor_check() {
    local current="${1:-}" minimum="${2:-}"
    _breeze_os_floor_valid "$current" || return 2
    _breeze_os_floor_valid "$minimum" || return 2
    # sw_vers reports 10.16 to binaries built against an old SDK when
    # SYSTEM_VERSION_COMPAT is set; it is never a real version.
    [ "$current" = "10.16" ] && return 2

    local c1 c2 c3 m1 m2 m3
    IFS=. read -r c1 c2 c3 <<EOF
$current
EOF
    IFS=. read -r m1 m2 m3 <<EOF
$minimum
EOF
    c1=$((10#${c1:-0})); c2=$((10#${c2:-0})); c3=$((10#${c3:-0}))
    m1=$((10#${m1:-0})); m2=$((10#${m2:-0})); m3=$((10#${m3:-0}))

    [ "$c1" -gt "$m1" ] && return 0
    [ "$c1" -lt "$m1" ] && return 1
    [ "$c2" -gt "$m2" ] && return 0
    [ "$c2" -lt "$m2" ] && return 1
    [ "$c3" -lt "$m3" ] && return 1
    return 0
}
