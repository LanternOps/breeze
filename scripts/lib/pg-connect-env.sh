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
_pg_url_decode() {
  local s="$1"
  # Escape literal backslashes first so only the \xHH sequences we inject
  # below are interpreted by `printf %b` — a backslash in the raw value must
  # not be treated as the start of an escape.
  s="${s//\\/\\\\}"
  s="${s//%/\\x}"
  printf '%b' "$s"
}

# _pg_url_query_param <query-string> <key>
# Print the (decoded) value of <key> from a "k=v&k2=v2" query string, or
# return 1 if the key is absent.
_pg_url_query_param() {
  local query="$1" key="$2" pair
  local IFS='&'
  for pair in $query; do
    case "$pair" in
      "${key}="*)
        _pg_url_decode "${pair#*=}"
        return 0
        ;;
    esac
  done
  return 1
}

# pg_url_to_env <postgres-url>
# Exports PGHOST, PGDATABASE, and (when present) PGPORT, PGUSER, PGPASSWORD,
# PGSSLMODE from a postgres:// or postgresql:// URL. Returns 1 (and prints a
# message on stderr) if the URL cannot be parsed, or is missing a host or
# database name.
pg_url_to_env() {
  local url="$1"
  # scheme://[user[:password]@]host[:port][/dbname][?query]
  local re='^postgres(ql)?://(([^:@/?]*)(:([^@/?]*))?@)?([^:@/?]+)(:([0-9]+))?(/([^?]*))?(\?(.*))?$'

  if [[ ! "$url" =~ $re ]]; then
    echo "pg_url_to_env: could not parse connection URL (expected postgres:// or postgresql://)" >&2
    return 1
  fi

  local user="${BASH_REMATCH[3]}"
  local password="${BASH_REMATCH[5]}"
  local host="${BASH_REMATCH[6]}"
  local port="${BASH_REMATCH[8]}"
  local dbname="${BASH_REMATCH[10]}"
  local query="${BASH_REMATCH[12]}"

  if [[ -z "$host" ]]; then
    echo "pg_url_to_env: connection URL is missing a host" >&2
    return 1
  fi
  if [[ -z "$dbname" ]]; then
    echo "pg_url_to_env: connection URL is missing a database name" >&2
    return 1
  fi

  export PGHOST="$host"
  export PGDATABASE
  PGDATABASE="$(_pg_url_decode "$dbname")"

  if [[ -n "$port" ]]; then
    export PGPORT="$port"
  fi
  if [[ -n "$user" ]]; then
    export PGUSER
    PGUSER="$(_pg_url_decode "$user")"
  fi
  if [[ -n "$password" ]]; then
    export PGPASSWORD
    PGPASSWORD="$(_pg_url_decode "$password")"
  fi

  if [[ -n "$query" ]]; then
    local sslmode
    if sslmode="$(_pg_url_query_param "$query" "sslmode")"; then
      export PGSSLMODE="$sslmode"
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
