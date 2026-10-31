package isolation

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func codeAt(t *testing.T, h *harness, at time.Time, gen int) string {
	t.Helper()
	code, err := BreakGlassCode(h.secret, idA, gen, at.Unix()/3600)
	if err != nil {
		t.Fatal(err)
	}
	return code
}

func TestLocalReleaseAcceptsAdjacentBuckets(t *testing.T) {
	for _, offset := range []time.Duration{-time.Hour, 0, time.Hour} {
		h := newHarness(t)
		h.mustIsolate(idA, 1)
		code := codeAt(t, h, h.clock.Now().Add(offset), 1)
		if err := h.m.LocalRelease(context.Background(), code, false); err != nil {
			t.Fatalf("bucket %v: %v", offset, err)
		}
		j := h.journal()
		if j.Episode.State != StateReleasedLocally || j.Episode.ReleaseKind != ReleaseLocalCode {
			t.Fatalf("bucket %v: state %q kind %q", offset, j.Episode.State, j.Episode.ReleaseKind)
		}
		if !containsStr(eventTypes(j), "released_local_code") {
			t.Fatalf("no released_local_code event: %v", eventTypes(j))
		}
		if installed, _, _ := h.iso.state(); installed {
			t.Fatal("rules still installed")
		}
	}
}

func TestLocalReleaseRejectsOtherBucketsAndGenerations(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	for _, code := range []string{
		codeAt(t, h, h.clock.Now().Add(2*time.Hour), 1),
		codeAt(t, h, h.clock.Now().Add(-2*time.Hour), 1),
		codeAt(t, h, h.clock.Now(), 2),
	} {
		if err := h.m.LocalRelease(context.Background(), code, false); !errors.Is(err, ErrBreakGlassInvalid) {
			t.Fatalf("code %s: err = %v, want ErrBreakGlassInvalid", code, err)
		}
	}
	if !h.m.Active() {
		t.Fatal("a wrong code released the isolation")
	}
}

func TestLocalReleaseNormalisesInput(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	code := codeAt(t, h, h.clock.Now(), 1)
	typed := strings.ToLower(code[:4]) + "-" + strings.ToLower(code[4:]) + " "
	if err := h.m.LocalRelease(context.Background(), typed, false); err != nil {
		t.Fatalf("lowercase/dashed code refused: %v", err)
	}
}

func TestLocalReleaseRateLimit(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	for i := 0; i < BreakGlassAttemptsPerHour; i++ {
		if err := h.m.LocalRelease(context.Background(), "AAAAAAAA", false); !errors.Is(err, ErrBreakGlassInvalid) {
			t.Fatalf("attempt %d: %v", i+1, err)
		}
	}
	good := codeAt(t, h, h.clock.Now(), 1)
	if err := h.m.LocalRelease(context.Background(), good, false); !errors.Is(err, ErrBreakGlassRateLimited) {
		t.Fatalf("6th attempt in the hour: err = %v, want ErrBreakGlassRateLimited", err)
	}
	if !h.m.Active() {
		t.Fatal("rate-limited attempt released the isolation")
	}
	// The limit survives a restart (attempts are journalled).
	h.m = h.newManager()
	if err := h.m.LocalRelease(context.Background(), good, false); !errors.Is(err, ErrBreakGlassRateLimited) {
		t.Fatalf("after restart: err = %v", err)
	}
	h.clock.Advance(time.Hour + time.Second)
	good = codeAt(t, h, h.clock.Now(), 1)
	if err := h.m.LocalRelease(context.Background(), good, false); err != nil {
		t.Fatalf("after the hour: %v", err)
	}
}

func TestLocalReleaseForce(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	if err := h.m.LocalRelease(context.Background(), "", true); err != nil {
		t.Fatal(err)
	}
	j := h.journal()
	if j.Episode.State != StateReleasedLocally || j.Episode.ReleaseKind != ReleaseLocalForced {
		t.Fatalf("forced release recorded as %q/%q, want released_locally/local_forced", j.Episode.State, j.Episode.ReleaseKind)
	}
	if !containsStr(eventTypes(j), "released_local_forced") {
		t.Fatalf("events %v", eventTypes(j))
	}
	r := h.m.Report()
	if r.State != StateReleasedLocally || r.Phase != "released" {
		t.Fatalf("report %+v", r)
	}
}

func TestLocalReleaseNothingActive(t *testing.T) {
	h := newHarness(t)
	if err := h.m.LocalRelease(context.Background(), "", true); !errors.Is(err, ErrNoActiveIsolation) {
		t.Fatalf("err = %v, want ErrNoActiveIsolation", err)
	}
}

func TestLocalReleaseWithoutSecretNeedsForce(t *testing.T) {
	h := newHarness(t)
	h.m.Reconcile(context.Background(), h.desired(idA, 1, DesiredIsolated, 72*time.Hour, false))
	if !h.m.Active() {
		t.Fatal("heartbeat isolate did not apply")
	}
	if err := h.m.LocalRelease(context.Background(), "AAAAAAAA", false); !errors.Is(err, ErrBreakGlassUnavailable) {
		t.Fatalf("err = %v, want ErrBreakGlassUnavailable", err)
	}
	if err := h.m.LocalRelease(context.Background(), "", true); err != nil {
		t.Fatalf("force without a secret: %v", err)
	}
}
