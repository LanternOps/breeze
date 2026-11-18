package heartbeat

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

var accessNow = time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)

func TestComputeDesktopAccess_X11Unchanged(t *testing.T) {
	cases := []struct {
		name       string
		probeErr   error
		wantMode   string
		wantReason string
	}{
		{"capturable", nil, "user_session", ""},
		{"no display", x11.ErrNoDisplay, "unavailable", "no_display_session"},
		{"auth failed", fmt.Errorf("wrapped: %w", x11.ErrAuthFailed), "unavailable", "x11_auth_failed"},
		{"connect failed", errors.New("dial unix: refused"), "unavailable", "x11_connect_failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			asked := false
			got := linuxDesktopAccessFromProbe(tc.probeErr, accessNow, func() bool { asked = true; return true })
			if got.Mode != tc.wantMode || got.Reason != tc.wantReason || !got.CheckedAt.Equal(accessNow) {
				t.Fatalf("got %+v, want mode %q reason %q", *got, tc.wantMode, tc.wantReason)
			}
			if asked {
				t.Fatal("an X11 outcome must never consult the Wayland helper")
			}
		})
	}
}

func TestComputeDesktopAccess_WaylandNoBackendStaysUnsupported(t *testing.T) {
	got := linuxDesktopAccessFromProbe(x11.ErrWaylandUnsupported, accessNow, func() bool { return false })
	if got.Mode != "unavailable" || got.Reason != "wayland_unsupported" {
		t.Fatalf("got %+v, want unavailable/wayland_unsupported", *got)
	}
	// No helper check available at all (flag off): same answer.
	got = linuxDesktopAccessFromProbe(x11.ErrWaylandUnsupported, accessNow, nil)
	if got.Mode != "unavailable" || got.Reason != "wayland_unsupported" {
		t.Fatalf("got %+v, want unavailable/wayland_unsupported", *got)
	}
}

func TestComputeDesktopAccess_WaylandCapableHelperIsUserSession(t *testing.T) {
	got := linuxDesktopAccessFromProbe(x11.ErrWaylandUnsupported, accessNow, func() bool { return true })
	if got.Mode != "user_session" || got.Reason != "" {
		t.Fatalf("got %+v, want user_session", *got)
	}
}

func TestLinuxWaylandHelperCanCapture(t *testing.T) {
	capable := &ipc.Capabilities{CanCapture: true}
	t.Run("flag off asks nobody", func(t *testing.T) {
		r := newLinuxRouteHarness(t, false, seatSession("4", "wayland"), true)
		r.helpers.bound["4"] = linuxDesktopTestSession(t, "4", capable, []string{"desktop"})
		if r.h.linuxWaylandHelperCanCapture() {
			t.Fatal("flag off must report no Wayland capture")
		}
		if r.seatCalls.Load() != 0 {
			t.Fatal("flag off must not consult logind")
		}
	})
	t.Run("capable helper bound to the active session", func(t *testing.T) {
		r := newLinuxRouteHarness(t, true, seatSession("4", "wayland"), true)
		r.helpers.bound["4"] = linuxDesktopTestSession(t, "4", capable, []string{"desktop"})
		if !r.h.linuxWaylandHelperCanCapture() {
			t.Fatal("a capable bound helper for the active Wayland session must count")
		}
	})
	t.Run("helper cannot capture", func(t *testing.T) {
		r := newLinuxRouteHarness(t, true, seatSession("4", "wayland"), true)
		r.helpers.bound["4"] = linuxDesktopTestSession(t, "4", &ipc.Capabilities{}, []string{"desktop"})
		if r.h.linuxWaylandHelperCanCapture() {
			t.Fatal("a helper root does not let capture must not count")
		}
	})
	t.Run("helper bound to another session", func(t *testing.T) {
		r := newLinuxRouteHarness(t, true, seatSession("4", "wayland"), true)
		r.helpers.bound["9"] = linuxDesktopTestSession(t, "9", capable, []string{"desktop"})
		if r.h.linuxWaylandHelperCanCapture() {
			t.Fatal("a helper for an inactive session must not count")
		}
	})
	t.Run("no helper is never spawned for the probe", func(t *testing.T) {
		r := newLinuxRouteHarness(t, true, seatSession("4", "wayland"), true)
		if r.h.linuxWaylandHelperCanCapture() {
			t.Fatal("no helper must report no Wayland capture")
		}
		if got := r.helpers.ensureCalls(); len(got) != 0 {
			t.Fatalf("the access probe must never spawn a helper, Ensure calls = %v", got)
		}
	})
}
