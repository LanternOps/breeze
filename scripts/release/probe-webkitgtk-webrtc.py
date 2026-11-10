#!/usr/bin/env python3
"""Does this host's WebKitGTK 4.1 expose RTCPeerConnection once WebRTC is enabled?

The Linux viewer AppImage bundles the build host's libwebkit2gtk-4.1, and most
distributions compile it without ENABLE_WEB_RTC. On such a build the
`enable-webrtc` setting exists and can be set, but does nothing, so the only
reliable test is to ask a real webview (#9557).

Needs a display (run under xvfb-run), python3-gi and gir1.2-webkit2-4.1.

Usage: probe-webkitgtk-webrtc.py [GLOBAL]
  GLOBAL  JavaScript global to look for (default: RTCPeerConnection). Passing
          one every build has, such as WebSocket, checks the probe itself.

Exit: 0 present, 3 absent, anything else means the probe could not tell.
"""

import os
import re
import sys

PRESENT, ABSENT, BROKEN, TIMED_OUT = 0, 3, 1, 4
TIMEOUT_SECONDS = 30


def main() -> int:
    name = sys.argv[1] if len(sys.argv) > 1 else "RTCPeerConnection"
    if not re.fullmatch(r"[A-Za-z_$][\w$]*", name):
        print(f"not a JavaScript identifier: {name!r}", file=sys.stderr)
        return BROKEN

    # The page is an inline constant, and CI containers often cannot start
    # WebKit's bubblewrap sandbox at all.
    os.environ.setdefault("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1")

    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import GLib, Gtk, WebKit2

    version = "{}.{}.{}".format(
        WebKit2.get_major_version(), WebKit2.get_minor_version(), WebKit2.get_micro_version()
    )
    outcome = {"code": TIMED_OUT}

    view = WebKit2.WebView()
    settings = view.get_settings()
    # The same two settings the viewer turns on (src-tauri/src/linux_webrtc.rs).
    settings.set_enable_webrtc(True)
    settings.set_enable_media_stream(True)

    def finish(code: int) -> None:
        outcome["code"] = code
        Gtk.main_quit()

    def on_result(view, result) -> None:
        try:
            kind = view.evaluate_javascript_finish(result).to_string()
        except GLib.Error as err:
            print(f"webkitgtk {version}: evaluating the probe failed: {err.message}")
            finish(BROKEN)
            return
        print(f"webkitgtk {version}: typeof {name} = {kind}")
        finish(ABSENT if kind == "undefined" else PRESENT)

    def on_load_changed(view, event) -> None:
        if event == WebKit2.LoadEvent.FINISHED:
            view.evaluate_javascript(f"typeof {name}", -1, None, None, None, on_result)

    def on_load_failed(view, event, uri, error) -> bool:
        print(f"webkitgtk {version}: the probe page failed to load: {error.message}")
        finish(BROKEN)
        return True

    def on_timeout() -> bool:
        print(f"webkitgtk {version}: no answer after {TIMEOUT_SECONDS}s")
        Gtk.main_quit()
        return False

    view.connect("load-changed", on_load_changed)
    view.connect("load-failed", on_load_failed)
    window = Gtk.OffscreenWindow()
    window.add(view)
    window.show_all()
    view.load_html("<!doctype html><title>probe</title>", "http://localhost/")
    GLib.timeout_add_seconds(TIMEOUT_SECONDS, on_timeout)
    Gtk.main()
    return outcome["code"]


if __name__ == "__main__":
    sys.exit(main())
