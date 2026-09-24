package hwhealth

import (
	"errors"
	"testing"
	"time"
)

func TestBreaker(t *testing.T) {
	now := time.Unix(100, 0)
	b := breaker{}
	for i := 0; i < 2; i++ {
		b.finish(now, errors.New("hung"))
		if b.blocked(now) {
			t.Fatal("early backoff")
		}
	}
	b.finish(now, errors.New("hung"))
	if !b.blocked(now.Add(6*time.Hour - time.Nanosecond)) {
		t.Fatal("missing backoff")
	}
	if b.blocked(now.Add(6 * time.Hour)) {
		t.Fatal("retry must be allowed")
	}
	b.finish(now.Add(6*time.Hour), nil)
	if b.failures != 0 || b.lastError != "" || b.blocked(now) {
		t.Fatal(b)
	}
}
