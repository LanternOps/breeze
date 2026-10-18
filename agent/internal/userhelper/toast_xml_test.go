package userhelper

import (
	"strings"
	"testing"
)

// buildToastXML is the one XML builder behind both the WinRT and PowerShell
// toast paths on Windows; the escaping it does is the injection boundary.
func TestBuildToastXML(t *testing.T) {
	got := buildToastXML("Breeze Agent", "A technician connected")
	want := `<toast><visual><binding template="ToastText02">` +
		`<text id="1">Breeze Agent</text>` +
		`<text id="2">A technician connected</text>` +
		`</binding></visual></toast>`
	if got != want {
		t.Fatalf("buildToastXML =\n%s\nwant\n%s", got, want)
	}
}

func TestBuildToastXMLEscapesMarkup(t *testing.T) {
	got := buildToastXML(`<b>"x"</b>`, `a & b </text><text id="3">injected`)
	for _, raw := range []string{"<b>", "</b>", `<text id="3">`, `"x"`, " & "} {
		if strings.Contains(got, raw) {
			t.Errorf("unescaped %q leaked into toast XML:\n%s", raw, got)
		}
	}
	if !strings.Contains(got, "&lt;b&gt;&#34;x&#34;&lt;/b&gt;") {
		t.Errorf("title not XML-escaped:\n%s", got)
	}
	if !strings.Contains(got, "a &amp; b &lt;/text&gt;") {
		t.Errorf("body not XML-escaped:\n%s", got)
	}
}

func TestBuildToastXMLReplacesInvalidXMLChars(t *testing.T) {
	got := buildToastXML("t\x00itle", "bo\x01dy")
	if strings.ContainsAny(got, "\x00\x01") {
		t.Fatalf("control characters leaked into toast XML: %q", got)
	}
}
