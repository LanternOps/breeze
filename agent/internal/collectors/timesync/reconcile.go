package timesync

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Reconciler struct {
	Read   ReadObservation
	Writer Writer
	Now    func() time.Time
	Save   func(ManagementState) error
	State  *ManagementState
}

func manualRole(role string) bool {
	return role == "workgroup" || role == "entra_only" || role == "forest_root_pdc_emulator"
}
func knownRole(role string) bool {
	return manualRole(role) || role == "member" || role == "dc" || role == "pdc_emulator"
}
func normalizedHosts(raw string) []string {
	h := ParseNtpServerHosts(raw)
	for i := range h {
		h[i] = strings.ToLower(h[i])
	}
	slices.Sort(h)
	return slices.Compact(h)
}
func matchesNTP(o Observation, s Settings) bool {
	if o.Config.ServiceStartType != "auto" || o.Config.ServiceState != "running" {
		return false
	}
	if !manualRole(o.Domain.Role) {
		return value(o.Config.Type, "NT5DS") || value(o.Config.Type, "AllSync")
	}
	return value(o.Config.Type, "NTP") && o.Config.NTPServer != nil &&
		slices.Equal(normalizedHosts(*o.Config.NTPServer), normalizedHosts(strings.Join(s.NTPServers, " "))) &&
		value(o.Config.SpecialPollIntervalSeconds, s.PollIntervalMinutes*60)
}
func ntpValues(o Observation) map[string]any {
	var start any
	if o.Config.ServiceStartType != "" {
		start = o.Config.ServiceStartType
	}
	return map[string]any{"type": scalar(o.Config.Type), "ntpServer": scalar(o.Config.NTPServer),
		"specialPollIntervalSeconds": scalar(o.Config.SpecialPollIntervalSeconds), "serviceStartType": start}
}
func zoneValues(o Observation) map[string]any {
	return map[string]any{"windowsId": scalar(o.Timezone.WindowsID)}
}
func newResult(s Settings, now time.Time, outcome, reason string, before, after map[string]any, err error) *EnforcementResult {
	fp := s.Fingerprint
	if len(fp) > 80 {
		fp = ""
	}
	return &EnforcementResult{ResultID: uuid.NewString(), Fingerprint: fp, At: now.UTC(),
		Outcome: outcome, Reason: reason, Before: before, After: after, Error: errorText(err)}
}
func gateDelay(failures int) time.Duration {
	if failures <= 1 {
		return time.Hour
	}
	if failures >= 6 {
		return 24 * time.Hour
	}
	return time.Hour << uint(failures-1)
}
func (r *Reconciler) Run(ctx context.Context, force bool) error {
	if r.State.Settings == nil || r.Writer == nil {
		return nil
	}
	s := *r.State.Settings
	if err := ValidateSettings(s); err != nil {
		r.State.Report.NTP = newResult(s, r.Now(), "skipped", "invalid_settings", ntpValues(Observation{}), ntpValues(Observation{}), err)
		if s.Timezone.AutoFix {
			r.State.Report.Timezone = newResult(s, r.Now(), "skipped", "invalid_settings", zoneValues(Observation{}), zoneValues(Observation{}), err)
		}
		return r.Save(*r.State)
	}
	if s.EnforceNTP {
		if e := r.runKind(ctx, s, false, force); e != nil {
			return e
		}
	}
	if s.Timezone.AutoFix {
		if e := r.runKind(ctx, s, true, force); e != nil {
			return e
		}
	}
	return nil
}
func (r *Reconciler) runKind(ctx context.Context, s Settings, zone, force bool) error {
	gate := &r.State.NTPGate
	slot := &r.State.Report.NTP
	values := ntpValues
	if zone {
		gate = &r.State.TimezoneGate
		slot = &r.State.Report.Timezone
		values = zoneValues
	}
	if gate.Fingerprint != s.Fingerprint {
		*gate = AttemptGate{Fingerprint: s.Fingerprint}
	}
	now := r.Now()
	// Next is wall-clock. A gate further ahead than any delay this code produces
	// means the clock stepped backward (often via our own resync); keep the
	// failure count but drop the stale absolute time so enforcement is not
	// blocked until real time catches up.
	if gate.Next.Sub(now) > gateDelay(gate.Failures) {
		gate.Next = now
	}
	if !force && now.Before(gate.Next) {
		return nil
	}
	// Reserve conservatively as a failure before any mutation, including across crashes.
	gate.Failures++
	gate.Next = now.Add(gateDelay(gate.Failures))
	if e := r.Save(*r.State); e != nil {
		return fmt.Errorf("reserve time policy attempt: %w", e)
	}
	before, readErr := r.Read(ctx)
	outcome, reason := "ok", "already_compliant"
	var opErr error
	if readErr != nil {
		outcome, reason, opErr = "failed", "exec_failed", readErr
	} else if !zone && !knownRole(before.Domain.Role) {
		outcome, reason = "skipped", "role_unknown"
	} else if !zone && before.Config.PolicyManaged {
		outcome, reason = "skipped", "conflict_gpo"
	} else if zone {
		// Spec §8.4: the W32Time role and Policies\Microsoft\W32Time do not govern the
		// timezone, so neither gates it; only autoUpdate and the zone key do.
		switch {
		case s.Timezone.ExpectedWindowsID == nil:
			outcome, reason = "skipped", "no_expected_timezone"
		case before.Timezone.AutoUpdate == "on":
			outcome, reason = "skipped", "auto_timezone_on"
		default:
			id := *s.Timezone.ExpectedWindowsID
			if e := r.Writer.ZoneExists(id); e != nil {
				outcome, reason, opErr = "skipped", "invalid_settings", e
			} else if !value(before.Timezone.WindowsID, id) {
				reason = "applied"
				opErr = r.guarded(ctx, before.Domain.Role, true, func() error { return r.Writer.Timezone(ctx, id) })
			}
		}
	} else if !matchesNTP(before, s) {
		reason = "applied"
		opErr = r.applyNTP(ctx, before, s)
	}
	if opErr != nil && reason == "applied" {
		var diagnostic *resyncDiagnostic
		var stop *guardStop
		if errors.As(opErr, &diagnostic) {
			// Read-back below still decides whether configuration applied successfully.
		} else if errors.As(opErr, &stop) {
			outcome, reason = "skipped", stop.reason
		} else {
			outcome, reason = "failed", "exec_failed"
		}
	}
	after := before
	// Do not lose partial writes in before/after if a later command or guard fails.
	if readErr == nil {
		var e error
		after, e = r.Read(ctx)
		if e != nil {
			after = Observation{}
			outcome, reason, opErr = "failed", "exec_failed", errors.Join(opErr, e)
		}
	}
	if outcome == "ok" {
		same := matchesNTP(after, s)
		if zone {
			same = s.Timezone.ExpectedWindowsID != nil && value(after.Timezone.WindowsID, *s.Timezone.ExpectedWindowsID)
		}
		if !same {
			outcome, reason = "failed", "readback_mismatch"
		}
	}
	if outcome != "failed" {
		gate.Failures = 0
		gate.Next = now.Add(time.Hour)
	}
	*slot = newResult(s, now, outcome, reason, values(before), values(after), opErr)
	return r.Save(*r.State)
}

type guardStop struct{ reason string }

func (e *guardStop) Error() string { return e.reason }
func (r *Reconciler) guarded(ctx context.Context, role string, zone bool, write func() error) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	fresh, e := r.Read(ctx)
	if e != nil {
		return e
	}
	if zone {
		// Timezone writes re-check only what gates them (spec §8.4), never W32Time role/GPO.
		if fresh.Timezone.AutoUpdate == "on" {
			return &guardStop{"auto_timezone_on"}
		}
		return write()
	}
	if !knownRole(fresh.Domain.Role) || fresh.Domain.Role != role {
		return &guardStop{"role_unknown"}
	}
	if fresh.Config.PolicyManaged {
		return &guardStop{"conflict_gpo"}
	}
	return write()
}

// resyncDiagnostic keeps a non-zero resync in Error without failing a verified apply.
type resyncDiagnostic struct{ err error }

func (e *resyncDiagnostic) Error() string { return "resync after apply: " + e.err.Error() }
func (r *Reconciler) applyNTP(ctx context.Context, before Observation, s Settings) error {
	role := before.Domain.Role
	guarded := func(fn func() error) error { return r.guarded(ctx, role, false, fn) }
	// W32Time must be running before any `w32tm /config ... /update`: with the
	// service stopped (the default for trigger-start W32Time on workgroup
	// Windows 10/11) /update exits 0x80070426 and every apply would fail.
	if e := guarded(func() error { return r.Writer.Automatic(ctx) }); e != nil {
		return e
	}
	fresh, e := r.Read(ctx)
	if e != nil {
		return e
	}
	if fresh.Config.ServiceState != "running" {
		if e = guarded(func() error { return r.Writer.Start(ctx) }); e != nil {
			return e
		}
	}
	if manualRole(role) {
		if e := guarded(func() error { return r.Writer.Manual(ctx, s.NTPServers, role == "forest_root_pdc_emulator") }); e != nil {
			return e
		}
		if e := guarded(func() error { return r.Writer.Poll(ctx, s.PollIntervalMinutes*60) }); e != nil {
			return e
		}
		if e := guarded(func() error { return r.Writer.Update(ctx) }); e != nil {
			return e
		}
	} else if e := guarded(func() error { return r.Writer.Hierarchy(ctx) }); e != nil {
		return e
	}
	var resyncErr error
	e = guarded(func() error { _, resyncErr = r.Writer.Resync(ctx); return nil })
	if e != nil {
		return e
	}
	if resyncErr != nil {
		return &resyncDiagnostic{resyncErr}
	}
	return nil
}
