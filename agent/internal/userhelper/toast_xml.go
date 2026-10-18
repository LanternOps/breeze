package userhelper

import (
	"encoding/xml"
	"strings"
)

// buildToastXML renders the Windows toast payload for a plain notice. It is
// untagged so the escaping — the only thing standing between a server-supplied
// title/body and the toast XML parser — is tested on every platform's CI, even
// though only the Windows user-helper raises the result.
func buildToastXML(title, body string) string {
	return `<toast><visual><binding template="ToastText02">` +
		`<text id="1">` + xmlEscape(title) + `</text>` +
		`<text id="2">` + xmlEscape(body) + `</text>` +
		`</binding></visual></toast>`
}

// xmlEscape encodes a string so it is safe for embedding in XML text content.
// Characters outside the XML character range (NUL and other C0 controls) are
// replaced with U+FFFD by encoding/xml rather than passed through.
func xmlEscape(s string) string {
	var b strings.Builder
	if err := xml.EscapeText(&b, []byte(s)); err != nil {
		return ""
	}
	return b.String()
}
