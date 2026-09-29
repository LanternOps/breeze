package timesync

import (
	"context"
	"errors"
	"fmt"
)

type ResyncResult struct {
	ExitCode int     `json:"exitCode"`
	Before   *string `json:"lastSuccessfulSyncAtBefore"`
	After    *string `json:"lastSuccessfulSyncAtAfter"`
	Error    *string `json:"error"`
}
type SetTimezoneResult struct {
	Before *string `json:"before"`
	After  *string `json:"after"`
	Error  *string `json:"error"`
}

func (m *Manager) Command(ctx context.Context, kind string, payload map[string]any) (any, error) {
	if e := m.lock(ctx); e != nil {
		return nil, e
	}
	defer m.unlock()
	if m.writer == nil {
		return nil, fmt.Errorf("time management unsupported on this OS")
	}
	var result any
	var actionErr error
	switch kind {
	case "time_resync":
		result, actionErr = m.resync(ctx, payload)
	case "time_set_timezone":
		result, actionErr = m.setTimezone(ctx, payload)
	case "time_apply_policy":
		if len(payload) != 0 {
			actionErr = fmt.Errorf("time_apply_policy payload must be empty")
		} else if m.blocked != nil {
			actionErr = m.blocked
		} else if actionErr = m.save(m.state); actionErr == nil {
			actionErr = m.reconciler().Run(ctx, true)
		}
		result = m.state.Report
		if actionErr == nil && m.state.Settings != nil {
			s := m.state.Settings
			for _, kind := range []struct {
				enabled bool
				result  *EnforcementResult
			}{
				{s.EnforceNTP, m.state.Report.NTP}, {s.Timezone.AutoFix, m.state.Report.Timezone},
			} {
				r := kind.result
				if kind.enabled && r != nil && r.Fingerprint == s.Fingerprint && r.Outcome == "failed" {
					actionErr = errors.Join(actionErr, fmt.Errorf("%s", r.Reason))
				}
			}
		}
	default:
		actionErr = fmt.Errorf("unknown time command")
	}
	// Even validation failures request a fresh snapshot; do not reconcile during manual commands.
	uploadErr := m.upload(ctx)
	return result, errors.Join(actionErr, uploadErr)
}
func (m *Manager) resync(ctx context.Context, payload map[string]any) (ResyncResult, error) {
	out := ResyncResult{ExitCode: 1}
	before, e := m.read(ctx)
	out.Before = before.Status.LastSuccessfulSyncAt
	if e == nil && len(payload) != 0 {
		e = fmt.Errorf("time_resync payload must be empty")
	}
	// Spec §9: resync changes no configuration, so the W32Time configuration-write
	// guards (known/unchanged role, not policy-managed) do not apply. GPO-managed and
	// role-unknown hosts are exactly where sync_stale hints send the operator here.
	if e == nil {
		e = ctx.Err()
	}
	if e == nil && before.Config.ServiceState != "running" {
		e = m.writer.Start(ctx)
	}
	if e == nil {
		out.ExitCode, e = m.writer.Resync(ctx)
	}
	after, readErr := m.read(ctx)
	out.After = after.Status.LastSuccessfulSyncAt
	e = errors.Join(e, readErr)
	if e != nil && out.ExitCode == 0 {
		out.ExitCode = 1
	}
	out.Error = errorText(e)
	return out, e
}
func (m *Manager) setTimezone(ctx context.Context, payload map[string]any) (SetTimezoneResult, error) {
	out := SetTimezoneResult{}
	before, e := m.read(ctx)
	out.Before = before.Timezone.WindowsID
	id, ok := payload["windowsId"].(string)
	if e == nil && (!ok || len(payload) != 1) {
		e = fmt.Errorf("time_set_timezone requires only windowsId")
	}
	if e == nil {
		e = m.writer.ZoneExists(id)
	}
	if e == nil {
		e = m.reconciler().guarded(ctx, before.Domain.Role, true, func() error { return m.writer.Timezone(ctx, id) })
	}
	after, readErr := m.read(ctx)
	out.After = after.Timezone.WindowsID
	e = errors.Join(e, readErr)
	if e == nil && !value(after.Timezone.WindowsID, id) {
		e = fmt.Errorf("timezone readback_mismatch")
	}
	out.Error = errorText(e)
	return out, e
}
