//go:build !windows

package helper

// readInstalledWebView2 is not applicable off Windows: Assist renders in
// WKWebView (macOS) or WebKitGTK (Linux), and webview2GateApplies is false.
func readInstalledWebView2(string) (string, bool) {
	return "", false
}
