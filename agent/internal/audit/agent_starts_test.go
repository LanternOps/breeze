package audit

import (
	"os"
	"reflect"
	"testing"
)

// The pending-restart record (#12827) asks which agents started after the one
// that wrote it. Every agent version writes an agent_start entry with its
// version at start, so this needs nothing from an older agent.
func TestAgentStartsAfterListsLaterStartsInOrder(t *testing.T) {
	l := newTestLogger(t)
	l.Log(EventAgentStart, "", map[string]any{"version": "0.8.0"})
	writer := l.LogEntry(EventAgentStart, "", map[string]any{"version": "1.0.0"})
	if writer == "" {
		t.Fatal("LogEntry returned no hash for a written entry")
	}
	l.Log(EventCommandReceived, "cmd-1", map[string]any{"note": "agent_start mentioned in a command"})
	l.Log(EventAgentStart, "", map[string]any{"version": "0.9.0"})
	l.Log(EventAgentStop, "", nil)
	l.Log(EventAgentStart, "", map[string]any{"version": "1.0.0"})

	got, found, err := l.AgentStartsAfter(writer)
	if err != nil || !found {
		t.Fatalf("AgentStartsAfter = %v, found %v, err %v", got, found, err)
	}
	if want := []string{"0.9.0", "1.0.0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("AgentStartsAfter = %v, want %v", got, want)
	}
}

func TestAgentStartsAfterReadsAcrossRotation(t *testing.T) {
	l := newTestLogger(t)
	writer := l.LogEntry(EventAgentStart, "", map[string]any{"version": "1.0.0"})
	l.Log(EventCommandReceived, "cmd", nil)
	if err := l.rotate(); err != nil { // the writer's entry is now in .1
		t.Fatal(err)
	}
	l.Log(EventAgentStart, "", map[string]any{"version": "0.9.0"})
	if _, err := os.Stat(l.backupName(1)); err != nil {
		t.Fatalf("setup: the log did not rotate: %v", err)
	}
	got, found, err := l.AgentStartsAfter(writer)
	if err != nil || !found {
		t.Fatalf("AgentStartsAfter = %v, found %v, err %v", got, found, err)
	}
	if want := []string{"0.9.0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("AgentStartsAfter across rotation = %v, want %v", got, want)
	}
}

func TestAgentStartsAfterReportsAnUnknownToken(t *testing.T) {
	l := newTestLogger(t)
	l.Log(EventAgentStart, "", map[string]any{"version": "1.0.0"})
	for _, tok := range []string{"", "no-such-entry"} {
		if _, found, err := l.AgentStartsAfter(tok); found || err != nil {
			t.Fatalf("AgentStartsAfter(%q) found %v err %v, want not found", tok, found, err)
		}
	}
	var nilLogger *Logger
	if _, _, err := nilLogger.AgentStartsAfter("x"); err == nil {
		t.Fatal("a disabled audit log claimed to know the agent history")
	}
	if nilLogger.LogEntry(EventAgentStart, "", nil) != "" {
		t.Fatal("a disabled audit log returned an entry hash")
	}
}

// A torn agent_start line (a crash mid-write) cannot be read, so its version
// is unknown: reported as "", which the reader treats as another version.
func TestAgentStartsAfterReportsATornStartAsUnknown(t *testing.T) {
	l := newTestLogger(t)
	writer := l.LogEntry(EventAgentStart, "", map[string]any{"version": "1.0.0"})
	if _, err := l.file.WriteString(`{"timestamp":"x","eventType":"agent_start","details":{"vers` + "\n"); err != nil {
		t.Fatal(err)
	}
	got, found, err := l.AgentStartsAfter(writer)
	if err != nil || !found {
		t.Fatalf("AgentStartsAfter = %v, found %v, err %v", got, found, err)
	}
	if want := []string{""}; !reflect.DeepEqual(got, want) {
		t.Fatalf("AgentStartsAfter with a torn start = %q, want %q", got, want)
	}
}
