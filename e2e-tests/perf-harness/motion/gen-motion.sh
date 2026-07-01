#!/usr/bin/env bash
# Generate the canonical motion clip for remote-desktop perf tests.
# Light-load (testsrc2, flat color bars). For heavy-throughput A/B, swap the
# lavfi source for a denser one, e.g.:
#   -f lavfi -i "mandelbrot=size=2560x1440:rate=60:maxiter=200"
set -euo pipefail
out="${1:-motion.mp4}"
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=2560x1440:rate=60" \
  -t 20 -c:v libx264 -preset veryfast -crf 30 -g 120 -pix_fmt yuv420p "$out"
echo "wrote $out ($(du -h "$out" | cut -f1))"
