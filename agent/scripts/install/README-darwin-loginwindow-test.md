# macOS LoginWindow Test

Use this on a second Mac that is not hosting the Breeze server.

## Stage the helper

From the repo checkout:

```bash
cd /Users/toddhebebrand/breeze
sudo ./agent/scripts/install/stage-darwin-loginwindow-test.sh
```

This script:

- builds `breeze-desktop-helper` to `/tmp/breeze-desktop-helper`
- installs `/usr/local/bin/breeze-desktop-helper`
- installs the Aqua and LoginWindow LaunchAgents
- validates both plists with `plutil`
- bootstraps the Aqua helper for the current console user

## Pre-flight checks

Run these before logout or reboot:

```bash
tail -n 100 /Library/Logs/Breeze/desktop-helper.log
/usr/local/bin/breeze-desktop-helper probe --context user_session
/usr/local/bin/breeze-desktop-helper probe --context login_window
launchctl print gui/$(id -u)/com.breeze.desktop-helper-user
```

Expected shape:

- startup probe log line exists
- `captureGranted=true` for `user_session`
- the Aqua LaunchAgent is loaded

`accessibility` and `fullDiskAccess` may still be false on a dev machine. The critical signal for this test is whether the selected backend can actually capture.

## Real login-window validation

1. Make sure the Breeze server is reachable from this Mac.
2. Start tailing logs from another session if possible:
   `tail -f /Library/Logs/Breeze/desktop-helper.log`
3. Log out or reboot to the macOS login window.
4. Before logging back in, verify from the Breeze dashboard:
   - the device is still online
   - `desktopAccess.mode` is `login_window`
   - a remote desktop connection can start
5. Log in locally.
6. Confirm the desktop session disconnects and reconnects onto `user_session`.
7. Log out again and confirm it returns to `login_window`.

## Files to inspect after logout or reboot

- `/Library/Logs/Breeze/desktop-helper.log`
- `/Library/Logs/Breeze/desktop-helper.log` when the helper can write it

Look for:

- `desktop helper startup probe`
- `context=login_window`
- `captureGranted=true`
- any `captureError=...`
- any IPC auth failure

## Cleanup

```bash
sudo launchctl bootout system/com.breeze.agent >/dev/null 2>&1 || true
sudo launchctl bootout gui/$(id -u)/com.breeze.desktop-helper-user >/dev/null 2>&1 || true
sudo rm -f /Library/LaunchAgents/com.breeze.desktop-helper-user.plist
sudo rm -f /Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist
sudo rm -f /usr/local/bin/breeze-desktop-helper
```
