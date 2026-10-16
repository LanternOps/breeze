package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestPlainTextFromMarkdown(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"plain", "Please call the office line.", "Please call the office line."},
		{"bold and italic", "**Reboot** tonight, *please* and __now__ or _soon_", "Reboot tonight, please and now or soon"},
		{"snake_case kept", "run update_tool.exe", "run update_tool.exe"},
		{"link shows real url", "See [the portal](https://help.example.com/x) now", "See the portal (https://help.example.com/x) now"},
		{"image is alt text only", "![logo](https://cdn.example.com/a.png) Hi", "logo Hi"},
		{"heading and quote", "# Outage\n> Phones down", "Outage\nPhones down"},
		{"bullets", "- one\n* two\n+ three", "• one\n• two\n• three"},
		{"code and strike", "Run `ipconfig` ~~now~~", "Run ipconfig now"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := plainTextFromMarkdown(c.in); got != c.want {
				t.Fatalf("plainTextFromMarkdown(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestNativeMessageRequestStripsMarkdown(t *testing.T) {
	req := nativeMessageRequest(ipc.MessageShow{Title: "Outage", Body: "**Phones** are down. [Status](https://status.example.com)", Severity: "info"})
	if req.Body != "Phones are down. Status (https://status.example.com)" {
		t.Fatalf("native body = %q", req.Body)
	}
}
