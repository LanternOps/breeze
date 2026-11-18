//go:build windows

package helper

import (
	"strconv"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// webview2ClientsKey is the EdgeUpdate client key of the WebView2 Evergreen
// runtime; its "pv" value is the installed version.
const webview2ClientsKey = `Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`

// readInstalledWebView2 returns the newest WebView2 Evergreen runtime version
// registered for the user of the given session: the per-machine install
// (WOW6432Node, then the native view) and the session user's per-user
// install. The agent runs as SYSTEM, so "HKCU" would be SYSTEM's own hive; the
// user's hive is read through HKEY_USERS\<SID> instead. The newest wins, so a
// refusal means every runtime the user could get is too old. ok is false when
// none is registered ("0.0.0.0" or empty counts as absent).
func readInstalledWebView2(sessionKey string) (string, bool) {
	var best webview2Version
	found := false
	consider := func(root registry.Key, path string) {
		k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
		if err != nil {
			return
		}
		defer func() { _ = k.Close() }()
		raw, _, err := k.GetStringValue("pv")
		if err != nil {
			return
		}
		if v, ok := parseWebView2Version(raw); ok && (!found || best.less(v)) {
			best, found = v, true
		}
	}
	consider(registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\`+webview2ClientsKey)
	consider(registry.LOCAL_MACHINE, `SOFTWARE\`+webview2ClientsKey)
	if sid := sessionUserSID(sessionKey); sid != "" {
		consider(registry.USERS, sid+`\SOFTWARE\`+webview2ClientsKey)
	}
	if !found {
		return "", false
	}
	return best.String(), true
}

// sessionUserSID returns the SID of the user signed in to the Windows session,
// or "" when it cannot be resolved (no user, or the agent lacks SeTcbPrivilege
// outside a service).
func sessionUserSID(sessionKey string) string {
	id, err := strconv.ParseUint(sessionKey, 10, 32)
	if err != nil || id == 0 {
		return ""
	}
	var token windows.Token
	if err := windows.WTSQueryUserToken(uint32(id), &token); err != nil {
		return ""
	}
	defer func() { _ = token.Close() }()
	user, err := token.GetTokenUser()
	if err != nil {
		return ""
	}
	return user.User.Sid.String()
}
