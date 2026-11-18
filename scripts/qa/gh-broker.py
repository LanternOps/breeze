#!/usr/bin/env python3
"""Read-only, repo-pinned GitHub broker for the scheduled QA sweep agent.

The agent runs under a Seatbelt profile with no route to GitHub and no read
access to gh's config, so it cannot run gh itself. Its only way to read GitHub
is scripts/qa/qa-gh, a client that hands its argv to this broker over loopback.
The broker runs OUTSIDE the sandbox, as the runner, and is the policy. It
exposes fixed subcommands with typed arguments only, and no free text reaches
gh, so nothing the agent writes can change what query gh builds:

  - only `issue list|view` and `pr list|view|diff`;
  - `view`/`diff` take exactly one bare number (no URL, no OWNER/REPO#N, no
    branch name: gh resolves those to whatever repository they name);
  - list filters are `--state` (a fixed set per command), `--limit` (bounded)
    and `--label` from LABELS. There is no `--search`, `--author` or `--base`:
    gh turns those into GitHub search text beside its own `repo:` pin, where
    operators and qualifiers can widen it. The sweep's dedupe list is computed
    by the runner before the agent starts (RUN_DIR/open-issues.tsv);
  - `--json` takes field names from JSON_FIELDS only; `-R/--repo/--hostname`,
    `--web`, `--jq`/`--template` (gh's jq exposes the broker's environment via
    $ENV) and anything unknown are refused;
  - the repository is always the one the runner fixed (`--repo`), and gh runs
    with the repo/host environment overrides removed.

  gh-broker.py --repo OWNER/NAME --port-file F --log L [--gh /path/to/gh]

Each request is logged one line per call (ALLOW/DENY + the sanitized argv) to a
file the agent cannot read or write. Python 3.9 stdlib only.
"""
import argparse
import json
import os
import re
import socketserver
import subprocess
import sys
import time

MAX_REQUEST = 16384
MAX_OUTPUT = 4 * 1024 * 1024
TIMEOUT = 90

NUM_RE = re.compile(r"^[0-9]{1,7}$")
LIMIT_RE = re.compile(r"^[0-9]{1,4}$")
# The labels the sweep reads by. A label is a fixed token, never search text.
LABELS = frozenset({"qa-sweep", "qa-swept", "qa-no-ui"})
JSON_FIELDS = frozenset({
    "number", "title", "state", "stateReason", "closed", "labels", "body", "comments", "author",
    "createdAt", "updatedAt", "closedAt", "mergedAt", "mergeCommit", "url", "milestone", "assignees",
    "files", "additions", "deletions", "changedFiles", "baseRefName", "headRefName", "isDraft",
    "reviewDecision", "commits",
})


# value validators; None = boolean flag
def _one_of(*allowed):
    return lambda v: v in allowed


def _num(v):
    return bool(LIMIT_RE.match(v)) and 1 <= int(v) <= 1000


def _label(v):
    return v in LABELS


def _fields(v):
    names = v.split(",")
    return 0 < len(names) <= len(JSON_FIELDS) and all(n in JSON_FIELDS for n in names)


LIST_COMMON = {
    "--label": _label, "-l": _label,
    "--limit": _num, "-L": _num,
    "--json": _fields,
}
VIEW_COMMON = {
    "--comments": None, "-c": None,
    "--json": _fields,
}
ISSUE_STATE = _one_of("open", "closed", "all")
PR_STATE = _one_of("open", "closed", "merged", "all")
ALLOWED = {
    ("issue", "list"): (dict(LIST_COMMON, **{"--state": ISSUE_STATE, "-s": ISSUE_STATE}), 0),
    ("pr", "list"): (dict(LIST_COMMON, **{"--state": PR_STATE, "-s": PR_STATE}), 0),
    ("issue", "view"): (dict(VIEW_COMMON), 1),
    ("pr", "view"): (dict(VIEW_COMMON), 1),
    ("pr", "diff"): ({"--name-only": None, "--patch": None, "--color": _one_of("never")}, 1),
}


def validate(argv, repo):
    """Return the full gh argv (minus the binary) for an allowed request, or raise ValueError."""
    if not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
        raise ValueError("argv must be a list of strings")
    if len(argv) < 2 or len(argv) > 40:
        raise ValueError("expected: issue list|view, pr list|view|diff")
    for a in argv:
        if "\x00" in a or "\n" in a or "\r" in a or len(a) > 1000:
            raise ValueError("control characters or oversized argument")
    key = (argv[0], argv[1])
    if key not in ALLOWED:
        raise ValueError("only issue list|view and pr list|view|diff are available")
    flags, npos = ALLOWED[key]
    out, positional = [], []
    rest = argv[2:]
    i = 0
    while i < len(rest):
        a = rest[i]
        if a.startswith("-") and a != "-":
            name, eq, val = a.partition("=") if a.startswith("--") else (a, "", "")
            if name not in flags:
                raise ValueError("flag not allowed: %s" % name)
            check = flags[name]
            if check is None:
                if eq:
                    raise ValueError("%s takes no value" % name)
                out.append(name)
            else:
                if not eq:
                    i += 1
                    if i >= len(rest):
                        raise ValueError("%s needs a value" % name)
                    val = rest[i]
                if not check(val):
                    raise ValueError("value not allowed for %s" % name)
                out += [name, val]
        else:
            if not NUM_RE.match(a):
                raise ValueError("the issue/PR must be a bare number (no URL, OWNER/REPO#N or branch)")
            positional.append(a)
        i += 1
    if len(positional) != npos:
        raise ValueError("expected %d issue/PR number(s), got %d" % (npos, len(positional)))
    return [argv[0], argv[1]] + positional + out + ["--repo", repo]


def gh_env():
    env = dict(os.environ)
    for k in ("GH_REPO", "GH_HOST", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR_OVERRIDE"):
        env.pop(k, None)
    env.update({"GH_PROMPT_DISABLED": "1", "GH_NO_UPDATE_NOTIFIER": "1", "NO_COLOR": "1",
                "GH_PAGER": "cat", "PAGER": "cat", "GH_HOST": "github.com"})
    return env


def clip(b):
    if len(b) > MAX_OUTPUT:
        b = b[:MAX_OUTPUT] + b"\n[qa-gh: output truncated]\n"
    return b.decode("utf-8", "replace")


class Handler(socketserver.StreamRequestHandler):
    def log(self, verdict, detail):
        detail = "".join(c if " " <= c <= "~" else "?" for c in detail)[:600]
        try:
            with open(self.server.log_path, "a") as f:
                f.write("%s %s %s\n" % (time.strftime("%H:%M:%SZ", time.gmtime()), verdict, detail))
        except OSError:
            pass

    def reply(self, obj):
        try:
            self.wfile.write((json.dumps(obj) + "\n").encode())
        except OSError:
            pass

    def handle(self):
        self.request.settimeout(15)
        try:
            line = self.rfile.readline(MAX_REQUEST + 1)
        except OSError:
            return
        if not line or len(line) > MAX_REQUEST:
            return self.reply({"rc": 2, "stdout": "", "stderr": "qa-gh: bad request\n"})
        argv = None
        try:
            argv = json.loads(line.decode("utf-8")).get("argv")
            full = validate(argv, self.server.repo)
        except (ValueError, AttributeError, UnicodeDecodeError) as e:
            self.log("DENY", json.dumps(argv) if isinstance(argv, list) else "<unparsable>")
            return self.reply({"rc": 2, "stdout": "", "stderr": "qa-gh: refused: %s\n" % e})
        self.log("ALLOW", " ".join(full))
        try:
            p = subprocess.run([self.server.gh] + full, stdin=subprocess.DEVNULL, capture_output=True,
                               timeout=TIMEOUT, env=gh_env(), cwd="/")
            self.reply({"rc": p.returncode, "stdout": clip(p.stdout), "stderr": clip(p.stderr)})
        except subprocess.TimeoutExpired:
            self.reply({"rc": 124, "stdout": "", "stderr": "qa-gh: timed out\n"})
        except OSError as e:
            self.reply({"rc": 127, "stdout": "", "stderr": "qa-gh: could not run gh: %s\n" % e})


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--port-file", required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--gh", default="gh")
    args = ap.parse_args()
    if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", args.repo):
        sys.exit("bad --repo")
    srv = Server(("127.0.0.1", 0), Handler)
    srv.repo, srv.log_path, srv.gh = args.repo, args.log, args.gh
    tmp = args.port_file + ".tmp"
    with open(tmp, "w") as f:
        f.write("%d\n" % srv.server_address[1])
    os.replace(tmp, args.port_file)
    srv.serve_forever()


if __name__ == "__main__":
    main()
