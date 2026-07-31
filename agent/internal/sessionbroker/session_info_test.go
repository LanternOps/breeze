package sessionbroker

import (
	"testing"
	"time"
)

func TestBuildSessionInfoItems(t *testing.T) {
	detected := []DetectedSession{
		{Session: "0", Username: "", State: "connected", Type: "services"},                                                     // filtered: services
		{Session: "1", Username: "console-user", State: "active", Type: "console", IdleFor: 7 * time.Minute, IdleKnown: true},  // kept, idle 7
		{Session: "3", Username: "rdp-alice", State: "active", Type: "rdp"},                                                    // kept, idle unknown
		{Session: "4", Username: "", State: "connected", Type: "rdp"},                                                          // filtered: no user (RDP listener)
		{Session: "not-a-number", Username: "x", State: "active", Type: "rdp"},                                                 // filtered: unparseable id
		{Session: "5", Username: "rdp-bob", State: "disconnected", Type: "rdp", IdleFor: 30 * 24 * time.Hour, IdleKnown: true}, // kept, idle capped
	}
	items := BuildSessionInfoItems(detected, map[string]bool{"3": true})

	if len(items) != 3 {
		t.Fatalf("expected 3 items, got %d: %+v", len(items), items)
	}
	if items[0].SessionID != 1 || items[0].IdleMinutes == nil || *items[0].IdleMinutes != 7 || items[0].HelperConnected {
		t.Errorf("item 0 wrong: %+v", items[0])
	}
	if items[1].SessionID != 3 || items[1].IdleMinutes != nil || !items[1].HelperConnected {
		t.Errorf("item 1 wrong: %+v", items[1])
	}
	if items[2].SessionID != 5 || items[2].IdleMinutes == nil || *items[2].IdleMinutes != 10080 || items[2].State != "disconnected" {
		t.Errorf("item 2 wrong: %+v", items[2])
	}
}

func TestBuildSessionInfoItemsNilHelperMap(t *testing.T) {
	items := BuildSessionInfoItems([]DetectedSession{{Session: "2", Username: "u", State: "active", Type: "rdp"}}, nil)
	if len(items) != 1 || items[0].HelperConnected {
		t.Fatalf("nil helper map should mean HelperConnected=false: %+v", items)
	}
}
