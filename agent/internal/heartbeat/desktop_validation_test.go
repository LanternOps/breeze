package heartbeat

import "testing"

func TestParseGUIUserUIDs(t *testing.T) {
	t.Parallel()

	output := "501 /System/Library/CoreServices/loginwindow\nbaduid /System/Library/CoreServices/loginwindow\n502 other\n501 /System/Library/CoreServices/loginwindow\n"
	uids := parseGUIUserUIDs(output)
	if len(uids) != 1 || uids[0] != "501" {
		t.Fatalf("parseGUIUserUIDs = %+v, want [501]", uids)
	}
}
