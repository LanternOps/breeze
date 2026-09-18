#!/usr/bin/env python3
"""Assert requirements.lock actually reflects requirements.in.

`requirements.lock` is a hash-pinned, hand-regenerated artifact (see
lock-wheels.py / README.md) — nothing forces someone bumping a version in
`requirements.in` to also re-run the lock step. A drift here means the
Dockerfile installs whatever version happens to be pinned in the lock file,
silently ignoring the version the `.in` file says is required.

This does not re-resolve dependencies or verify hashes — it only asserts that
every `name==version` pin in requirements.in has a matching `name==version`
line in requirements.lock. Package names are compared using PEP 503
normalization (case-insensitive, `-`/`_`/`.` treated the same) since the lock
file spells some names with underscores (`python_docx`) while requirements.in
uses dashes (`python-docx`).
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REQUIREMENTS_IN = HERE / "requirements.in"
REQUIREMENTS_LOCK = HERE / "requirements.lock"

PIN_RE = re.compile(r"^([A-Za-z0-9._-]+)==([A-Za-z0-9._+-]+)")


def normalize_name(name: str) -> str:
    # PEP 503 normalization.
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_pins(path: Path) -> dict[str, str]:
    pins: dict[str, str] = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = PIN_RE.match(line)
        if not match:
            continue
        name, version = match.group(1), match.group(2)
        pins[normalize_name(name)] = version
    return pins


def main() -> int:
    in_pins = parse_pins(REQUIREMENTS_IN)
    lock_pins = parse_pins(REQUIREMENTS_LOCK)

    mismatches = []
    for name, version in sorted(in_pins.items()):
        locked_version = lock_pins.get(name)
        if locked_version is None:
            mismatches.append(f"{name}=={version} is in requirements.in but missing from requirements.lock")
        elif locked_version != version:
            mismatches.append(
                f"{name}=={version} in requirements.in but requirements.lock has {name}=={locked_version}"
            )

    if mismatches:
        print("requirements.lock is out of sync with requirements.in:", file=sys.stderr)
        for mismatch in mismatches:
            print(f"  - {mismatch}", file=sys.stderr)
        print(
            "Regenerate the lock file (see docker/ai-workspace/README.md) before merging.",
            file=sys.stderr,
        )
        return 1

    print(f"requirements.lock matches requirements.in for all {len(in_pins)} direct pins.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
