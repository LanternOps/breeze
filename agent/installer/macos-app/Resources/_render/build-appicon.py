#!/usr/bin/env python3
"""Render the NU AppIcon SVG into a macOS .icns set.

Requires: Google Chrome (for headless SVG rasterization) and iconutil.
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SVG = HERE / "AppIcon.svg"
OUT = HERE.parent / "AppIcon.icns"


def run(cmd, **kwargs):
    print("$", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, check=True, **kwargs)


def render_with_chrome(svg: Path, png: Path, width: int, height: int) -> None:
    chrome = Path(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    )
    if not chrome.exists():
        raise RuntimeError("Google Chrome is required to render the SVG")
    run([
        str(chrome),
        "--headless",
        "--disable-gpu",
        f"--screenshot={png}",
        f"--window-size={width},{height}",
        "--hide-scrollbars",
        f"file://{svg}",
    ], capture_output=True)


def main() -> int:
    if not SVG.exists():
        print(f"Missing SVG: {SVG}", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        raw = tmp / "raw.png"
        render_with_chrome(SVG, raw, 1024, 1024)

        iconset = tmp / "AppIcon.iconset"
        iconset.mkdir()
        sizes = [
            (16, 16, "icon_16x16.png"),
            (32, 32, "icon_16x16@2x.png"),
            (32, 32, "icon_32x32.png"),
            (64, 64, "icon_32x32@2x.png"),
            (128, 128, "icon_128x128.png"),
            (256, 256, "icon_128x128@2x.png"),
            (256, 256, "icon_256x256.png"),
            (512, 512, "icon_256x256@2x.png"),
            (512, 512, "icon_512x512.png"),
            (1024, 1024, "icon_512x512@2x.png"),
        ]
        for w, h, name in sizes:
            run(["sips", "-z", str(h), str(w), str(raw), "--out", str(iconset / name)],
                capture_output=True)

        if OUT.exists():
            shutil.move(str(OUT), str(OUT.with_suffix(".icns.bak")))
        run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT)], capture_output=True)
        print(f"Created {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
