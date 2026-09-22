#!/usr/bin/env python3
"""Read the failed-file count out of a rebuild progress body.

Usage: read-failed-files.py <progress-body.json>
Prints the count on stdout and exits 0, or explains on stderr and exits 1.

The console posts a `rebuild.Result` (agent/internal/backup/rebuild/types.go),
whose summary counter is `filesFailed` — NOT `failedFiles`, which is the
name `bmr.RecoveryResult` uses for a *list* of paths on a different payload
(see the hazard note in the W09 plan doc). Confusing the two is what made
CI run 35675175188 report "failedFiles=-1 (want 0)" against a rebuild that
had actually restored 16,325 files with zero failures.

Hence: no defaulting. A body that does not carry an exact, non-negative
integer count is a hard failure here, so the caller can never mistake "the
count could not be established" for a count.
"""

import json
import sys


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <progress-body.json>", file=sys.stderr)
        return 2
    path = argv[1]
    try:
        with open(path, encoding="utf-8") as fh:
            body = json.load(fh)
    except (OSError, ValueError) as err:
        print(f"{path}: not readable as JSON: {err}", file=sys.stderr)
        return 1

    if not isinstance(body, dict):
        print(f"{path}: top level is {type(body).__name__}, want a JSON object", file=sys.stderr)
        return 1
    result = body.get("result")
    if not isinstance(result, dict):
        print(
            f"{path}: no 'result' object in the progress body "
            f"(got {type(result).__name__}) — nothing reported the rebuild outcome",
            file=sys.stderr,
        )
        return 1
    if "filesFailed" not in result:
        print(
            f"{path}: result has no 'filesFailed' counter "
            f"(keys: {sorted(result)}) — the rebuild engine must report an exact count",
            file=sys.stderr,
        )
        return 1
    count = result["filesFailed"]
    # bool is an int subclass in Python; a JSON true is not a count.
    if isinstance(count, bool) or not isinstance(count, int):
        print(
            f"{path}: result.filesFailed is {count!r} ({type(count).__name__}), want an integer",
            file=sys.stderr,
        )
        return 1
    if count < 0:
        print(f"{path}: result.filesFailed is {count}, want a non-negative count", file=sys.stderr)
        return 1

    print(count)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
