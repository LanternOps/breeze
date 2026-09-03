#!/usr/bin/env bash
#
# pg-connect-env.sh — split a libpq connection URL into PG* environment
# variables so pg_dump/pg_restore/psql never receive the credential as a
# command-line argument.
#
# Why: pg_dump/pg_restore/psql accept a connection URI as a positional
# argument (or via -d/--dbname), but any argv value is visible for the life
# of the process to every local user via `ps -o args` (or `ps aux`) — a
# password embedded in the URL leaks for as long as the dump/restore runs
# (issue #4497). Environment variables are NOT shown by `ps`; reading another
# user's environ requires root (via /proc/<pid>/environ), which is the same
# trust boundary these tools already assume.
#
# Usage:
#   source "$(dirname "$0")/lib/pg-connect-env.sh"
#   if ! pg_url_to_env "$DATABASE_URL"; then
#     die "could not parse DATABASE_URL"
#   fi
#   pg_dump -Fc -Z 6 -f "$dest"   # PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
#                                 # (+PGSSLMODE) come from the environment —
#                                 # no secret on argv.
#   pg_url_unset_env

# _pg_url_decode <value>
# Percent-decode an RFC 3986 URI component (user/password/dbname may contain
# %XX-escaped characters, e.g. a literal '@' or '/' in a generated password).
# Validates every '%' is followed by exactly two hex digits BEFORE handing
# anything to `printf %b` — a bare/short/non-hex '%XX' sequence would
# otherwise make `printf` either fail non-obviously or (on some platforms)
# silently emit a mangled value, which previously reached PGPASSWORD/PGUSER/
# PGDATABASE unnoticed. Returns 1 (message on stderr) on invalid encoding.
_pg_url_decode() {
  local s="$1" rest="$1"
  while [[ "$rest" == *%* ]]; do
    rest="${rest#*%}"
    if [[ ! "$rest" =~ ^[0-9A-Fa-f]{2} ]]; then
      echo "_pg_url_decode: invalid percent-encoding near '%${rest:0:2}'" >&2
      return 1
    fi
    rest="${rest:2}"
  done
  # Escape literal backslashes first so only the \xHH sequences we inject
  # below are interpreted by `printf %b` — a backslash in the raw value must
  # not be treated as the start of an escape.
  s="${s//\\/\\\\}"
  s="${s//%/\\x}"
  printf '%b' "$s"
}

# _pg_url_query_param <query-string> <key>
# Print the (decoded) value of <key> from a "k=v&k2=v2" query string, or
# return 1 if the key is absent or its value fails to decode.
_pg_url_query_param() {
  local query="$1" key="$2" pair
  local IFS='&'
  for pair in $query; do
    case "$pair" in
      "${key}="*)
        _pg_url_decode "${pair#*=}"
        return $?
        ;;
    esac
  done
  return 1
}

# _pg_url_extra_query_params <query-string>
# Print a comma-separated list of query-string keys other than "sslmode" —
# used to surface (not silently drop) connection parameters this helper
# doesn't translate to a PG* environment variable, e.g. connect_timeout,
# sslrootcert, application_name.
_pg_url_extra_query_params() {
  local query="$1" pair key
  local names=()
  local IFS='&'
  for pair in $query; do
    key="${pair%%=*}"
    [[ "$key" == "sslmode" || -z "$key" ]] && continue
    names+=("$key")
  done
  # Guard the array expansion: under `set -u`, `${names[*]}` on a still-empty
  # array is treated as an unbound variable on bash < 4.4 (macOS ships 3.2).
  if [[ ${#names[@]} -eq 0 ]]; then
    return 0
  fi
  local out_ifs="$IFS"
  IFS=','
  echo "${names[*]}"
  IFS="$out_ifs"
}

# pg_url_to_env <postgres-url>
# Exports PGHOST, PGDATABASE, and (when present) PGPORT, PGUSER, PGPASSWORD,
# PGSSLMODE from a postgres:// or postgresql:// URL. Returns 1 (and prints a
# message on stderr) if the URL cannot be parsed, is missing a host or
# database name, or contains an undecodable (malformed percent-encoded)
# user/password/database name. Nothing is exported unless the whole URL
# validates, so a rejected URL never leaves partial/stale PG* vars behind.
# The host portion accepts a bracketed IPv6 literal (e.g. "[::1]"), per
# RFC 3986 §3.2.2; the brackets are stripped before exporting PGHOST, since
# libpq's PGHOST accepts a bare IPv6 address (brackets are a URI-syntax-only
# disambiguation for the port separator).
pg_url_to_env() {
  local url="$1"
  # scheme://[user[:password]@](host|[ipv6-host])[:port][/dbname][?query]
  local re='^postgres(ql)?://(([^:@/?]*)(:([^@/?]*))?@)?(\[[^]]+\]|[^:@/?]+)(:([0-9]+))?(/([^?]*))?(\?(.*))?$'

  if [[ ! "$url" =~ $re ]]; then
    echo "pg_url_to_env: could not parse connection URL (expected postgres:// or postgresql://)" >&2
    return 1
  fi

  # `:-` on every optional group: bash 5.x (glibc) leaves BASH_REMATCH[n]
  # UNSET for a trailing subexpression that did not participate (e.g. no
  # `?query`), so under `set -u` a bare "${BASH_REMATCH[12]}" aborts the
  # caller. macOS bash 3.2 sets it to "" instead, which is why this only
  # surfaced in CI.
  local user_raw="${BASH_REMATCH[3]:-}"
  local password_raw="${BASH_REMATCH[5]:-}"
  local host_raw="${BASH_REMATCH[6]:-}"
  local port="${BASH_REMATCH[8]:-}"
  local dbname_raw="${BASH_REMATCH[10]:-}"
  local query="${BASH_REMATCH[12]:-}"

  if [[ -z "$host_raw" ]]; then
    echo "pg_url_to_env: connection URL is missing a host" >&2
    return 1
  fi
  if [[ -z "$dbname_raw" ]]; then
    echo "pg_url_to_env: connection URL is missing a database name" >&2
    return 1
  fi

  local host="$host_raw"
  if [[ "$host" == \[*\] ]]; then
    # Strip the [ ] brackets (not `${host:1:-1}` — negative-length substring
    # expansion needs bash 4.2+; macOS ships bash 3.2).
    host="${host#\[}"
    host="${host%\]}"
  fi

  # Decode everything and validate BEFORE exporting anything, so a failure
  # here never leaves a partially-populated (stale/wrong) PG* environment.
  local dbname user password sslmode
  if ! dbname="$(_pg_url_decode "$dbname_raw")"; then
    echo "pg_url_to_env: invalid database name in connection URL" >&2
    return 1
  fi
  if [[ -n "$user_raw" ]] && ! user="$(_pg_url_decode "$user_raw")"; then
    echo "pg_url_to_env: invalid user in connection URL" >&2
    return 1
  fi
  if [[ -n "$password_raw" ]] && ! password="$(_pg_url_decode "$password_raw")"; then
    echo "pg_url_to_env: invalid password in connection URL" >&2
    return 1
  fi
  if [[ -n "$query" ]] && ! sslmode="$(_pg_url_query_param "$query" "sslmode")"; then
    sslmode=""
  fi

  export PGHOST="$host"
  export PGDATABASE="$dbname"
  if [[ -n "$port" ]]; then
    export PGPORT="$port"
  fi
  if [[ -n "$user_raw" ]]; then
    export PGUSER="$user"
  fi
  if [[ -n "$password_raw" ]]; then
    export PGPASSWORD="$password"
  fi
  if [[ -n "$sslmode" ]]; then
    export PGSSLMODE="$sslmode"
  fi

  if [[ -n "$query" ]]; then
    local extra
    extra="$(_pg_url_extra_query_params "$query")"
    if [[ -n "$extra" ]]; then
      echo "pg_url_to_env: WARNING: ignoring unsupported connection URL parameter(s): ${extra} (only sslmode is translated to a PG* env var; extend scripts/lib/pg-connect-env.sh if this matters)" >&2
    fi
  fi

  return 0
}

# pg_url_unset_env
# Defensive cleanup: unset the PG* vars exported by pg_url_to_env once the
# connection is no longer needed, so a credential doesn't linger in the
# script's own environment for the rest of its run.
pg_url_unset_env() {
  unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE
}
