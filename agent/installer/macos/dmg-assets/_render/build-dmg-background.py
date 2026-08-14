#!/usr/bin/env python3
"""Render the NU DMG background HTML into 1x and @2x PNGs.

Requires: Google Chrome (headless) and sips.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HTML = HERE / "background.html"
OUT_1X = HERE.parent / "background.png"
OUT_2X = HERE.parent / "background@2x.png"


def run(cmd, **kwargs):
    print("$", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, check=True, **kwargs)


def main() -> int:
    if not HTML.exists():
        print(f"Missing {HTML}", file=sys.stderr)
        return 1

    chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    if not chrome.exists():
        raise RuntimeError("Google Chrome is required")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        raw = tmp / "raw.png"
        # Copy adjacent nu-logo.svg so the CSS background-image resolves
        logo_src = HERE / "nu-logo.svg"
        logo_dst = tmp / "nu-logo.svg"
        if logo_src.exists():
            shutil.copy(logo_src, logo_dst)
        html_dst = tmp / "background.html"
        shutil.copy(HTML, html_dst)

        run([
            str(chrome),
            "--headless",
            "--disable-gpu",
            f"--screenshot={raw}",
            "--window-size=1280,760",
            "--hide-scrollbars",
            f"file://{html_dst}",
        ], capture_output=True)

        one_x = tmp / "1x.png"
        run(["sips", "-z", "760", "1280", str(raw), "--out", str(one_x)], capture_output=True)
        if OUT_1X.exists():
            shutil.move(str(OUT_1X), str(OUT_1X.with_suffix(".png.bak")))
        shutil.copy(one_x, OUT_1X)

        two_x = tmp / "2x.png"
        run(["sips", "-z", "1520", "2560", str(one_x), "--out", str(two_x)], capture_output=True)
        if OUT_2X.exists():
            shutil.move(str(OUT_2X), str(OUT_2X.with_suffix(".png.bak")))
        shutil.copy(two_x, OUT_2X)

        print(f"Created {OUT_1X} ({OUT_1X.stat().st_size} bytes)")
        print(f"Created {OUT_2X} ({OUT_2X.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
