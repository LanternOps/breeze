# Motion source (consistent encoder load for A/B)

`motion-video.html` plays `motion.mp4` fullscreen, muted, looping. Video decode
is not requestAnimationFrame-gated, so it survives kiosk focus loss (unlike the
`motion.html` canvas animation, kept as a lighter alternative).

1. Generate the clip: `./gen-motion.sh` (needs ffmpeg) → `motion.mp4` (~12MB, gitignored).
2. Copy `motion.mp4` + `motion-video.html` to the target (e.g. `C:\tmp\`).
3. **Prevent the console from locking** (else capture goes to the static lock
   screen): machine-wide `powercfg /change monitor-timeout-ac 0` +
   `standby-timeout-ac 0` and `InactivityTimeoutSecs=0`; per-user set sign-in-on-
   wake = Never + screen saver None.
4. Launch fullscreen on the CONSOLE session (session 1):
   `msedge --kiosk "file:///C:/tmp/motion-video.html" --edge-kiosk-type=fullscreen --autoplay-policy=no-user-gesture-required`
   or register an Interactive-principal scheduled task (see the tracking doc).

## `bursty.html` — active/idle cadence for the RTP media-clock pacing bug

`bursty.html` animates high-motion canvas content for `ACTIVE_MS`, then **stops
drawing entirely** (`cancelAnimationFrame`, no rAF) for `IDLE_MS`, looping. The
idle window makes the captured screen go genuinely static, so DXGI reports no new
frame and the agent SKIPS frames — exactly when the fixed-`1/fps` RTP timestamp
increment drifts behind wall-clock. Watch it with the harness's `mediaClockDriftMs`
/ `p95FramePacingErrorMs` metrics.

- Knobs (URL query, ms): `?active=1500&idle=1500` (both default 1500).
- Motion is frame-counter driven (reproducible); cursor hidden, black background;
  an on-screen HUD shows ACTIVE (green) / IDLE (red) + frame count.
- Launch fullscreen on the console session, e.g.:
  `msedge --kiosk "file:///C:/tmp/bursty.html?active=1500&idle=1500" --edge-kiosk-type=fullscreen`

`tools/devpush_proxy.py` is the stable Tailscale→caddy TCP proxy for dev-push.
