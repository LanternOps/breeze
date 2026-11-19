#!/usr/bin/env bash
# Report whether the WebKitGTK the Linux viewer AppImage is about to bundle has
# WebRTC (#9557). Reports only: it always exits 0, because a WebKitGTK without
# WebRTC is a known packaging gap and a broken probe is not worth a release.
#
# Usage: report-viewer-linux-webrtc.sh <probe command...>
#   The probe exits 0 (present), 3 (absent) or anything else (could not tell);
#   see probe-webkitgtk-webrtc.py.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <probe command...>" >&2
  exit 0
fi

output=$("$@" 2>&1)
code=$?
[ -n "$output" ] && printf '%s\n' "$output"

case "$code" in
  0)
    level=notice
    message="The build host's WebKitGTK has WebRTC. The Linux viewer can reach devices whose agent runs as a service; the limitation documented under 'Linux viewer (AppImage)' in the remote access docs can be removed."
    ;;
  3)
    level=warning
    message="The build host's WebKitGTK was built without WebRTC, and the AppImage bundles it. This Linux viewer cannot open a remote desktop on a device whose agent runs as a service (every Windows device); see #9557."
    ;;
  *)
    level=error
    message="WebRTC support in the build host's WebKitGTK could not be determined (probe exit ${code}). The build continues; check the probe output above."
    ;;
esac

echo "::${level}::${message}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### Linux viewer WebRTC\n\n%s\n' "$message" >> "$GITHUB_STEP_SUMMARY"
fi
exit 0
