"""Generate platform-specific pip hashes from a fresh wheel download directory."""
import hashlib
from pathlib import Path

root = Path(__file__).resolve().parent
wheels = sorted((root / "wheels").glob("*.whl"))
if not wheels:
    raise SystemExit("No wheels found; download into docker/ai-workspace/wheels first")
lines = ["# CPython 3.13, Linux amd64 wheels; regenerate as described in README.md."]
seen = set()
for wheel in wheels:
    name, version = wheel.name.split("-")[:2]
    if name in seen:
        raise SystemExit(f"Multiple wheels for {name}; use a fresh wheel directory")
    seen.add(name)
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    lines.append(f"{name}=={version} --hash=sha256:{digest}")
(root / "requirements.lock").write_text("\n".join(lines) + "\n")
