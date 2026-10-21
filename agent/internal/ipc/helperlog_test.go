package ipc

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSanitizeHelperLogRecordAcceptsWarnAndError(t *testing.T) {
	for _, level := range []string{"warn", "error", "WARN", " Error "} {
		rec, ok := SanitizeHelperLogRecord(HelperLogRecord{Level: level, Message: "m"})
		if !ok {
			t.Fatalf("level %q rejected", level)
		}
		if rec.Level != strings.ToLower(strings.TrimSpace(level)) {
			t.Fatalf("level %q normalised to %q", level, rec.Level)
		}
	}
}

// Only warn+ crosses the boundary: a helper that sends info/debug (or a
// made-up level) is refused, so the relay can never become a chatty channel.
func TestSanitizeHelperLogRecordRejectsOtherLevels(t *testing.T) {
	for _, level := range []string{"", "info", "debug", "fatal", "warning!"} {
		if _, ok := SanitizeHelperLogRecord(HelperLogRecord{Level: level, Message: "m"}); ok {
			t.Fatalf("level %q accepted", level)
		}
	}
}

func TestHelperLogCap(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	c := NewHelperLogCap(base)
	for i := 0; i < HelperLogBurst; i++ {
		if ok, _ := c.Allow(base); !ok {
			t.Fatalf("record %d refused inside the burst", i)
		}
	}
	for i := 0; i < 5; i++ {
		if ok, _ := c.Allow(base); ok {
			t.Fatal("record admitted past the burst with no refill")
		}
	}
	// A clock that steps backwards must not mint tokens.
	if ok, _ := c.Allow(base.Add(-time.Hour)); ok {
		t.Fatal("backwards clock admitted a record")
	}
	ok, dropped := c.Allow(base.Add(HelperLogRefill))
	if !ok || dropped != 6 {
		t.Fatalf("after one refill: ok=%v dropped=%d, want true 6", ok, dropped)
	}
	if ok, _ := c.Allow(base.Add(HelperLogRefill)); ok {
		t.Fatal("one refill interval admitted two records")
	}
}

func TestSanitizeHelperLogRecordBoundsSize(t *testing.T) {
	fields := map[string]string{}
	for i := 0; i < MaxHelperLogFields+10; i++ {
		fields[fmt.Sprintf("k%03d", i)] = strings.Repeat("v", MaxHelperLogFieldValueBytes+50)
	}
	fields[strings.Repeat("K", MaxHelperLogFieldKeyBytes+20)] = "long key"

	rec, ok := SanitizeHelperLogRecord(HelperLogRecord{
		Level:     "warn",
		Component: strings.Repeat("c", MaxHelperLogComponentBytes+20),
		Message:   strings.Repeat("m", MaxHelperLogMessageBytes+100),
		Fields:    fields,
	})
	if !ok {
		t.Fatal("oversized record rejected; it must be truncated, not dropped")
	}
	if len(rec.Message) > MaxHelperLogMessageBytes+len(helperLogTruncSuffix) {
		t.Errorf("message len %d exceeds bound", len(rec.Message))
	}
	if len(rec.Component) > MaxHelperLogComponentBytes {
		t.Errorf("component len %d exceeds bound", len(rec.Component))
	}
	if len(rec.Fields) > MaxHelperLogFields {
		t.Errorf("%d fields, want <= %d", len(rec.Fields), MaxHelperLogFields)
	}
	for k, v := range rec.Fields {
		if len(k) > MaxHelperLogFieldKeyBytes {
			t.Errorf("field key len %d exceeds bound", len(k))
		}
		if len(v) > MaxHelperLogFieldValueBytes+len(helperLogTruncSuffix) {
			t.Errorf("field %q value len %d exceeds bound", k, len(v))
		}
	}
}
