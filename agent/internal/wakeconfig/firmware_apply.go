package wakeconfig

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
)

// Firmware writes (W04). A firmware setting is written only when all of these
// hold, checked in this order:
//
//  1. writes are activated and configure_settings is on (the same gate as the
//     Windows writes);
//  2. the adapter's vendor is in a fresh firmware_writes grant, and the adapter
//     is the one that produced this cycle's read;
//  3. the whole firmware layer was read and judged wrong (evaluateFirmware):
//     every target present exactly once with its target value allowed. An
//     unproven layer is never written, even where one target reads wrong;
//  4. the BIOS Admin password reads as not set (Protection == ProtectionNone);
//     set or unknown is firmware_protected;
//  5. the setting's limiter allows an attempt (1 per 24 h, stop after 3);
//  6. the BitLocker guard positively establishes a safe state (checkBitLocker);
//     a block is firmware_protected and spends no attempt.
//
// Only names and values from the compile-time firmwareTargets reach
// Adapter.Apply. Breeze never suspends BitLocker and never reboots: a written
// value stays needs_reboot until a later boot.

const firmwareKeyPrefix = "firmware:"

// Firmware reasons (Compute adds the BitLocker ones from the guard).
const (
	reasonFirmwarePasswordSet       = "firmware_password_set"
	reasonFirmwareProtectionUnknown = "firmware_protection_unknown"
)

// firmwareOp is one target write.
type firmwareOp struct {
	Vendor, Name, Value string
}

// Key identifies the setting for the limiter and pending state.
func (o firmwareOp) Key() string { return firmwareKeyPrefix + o.Vendor + ":" + o.Name }

// firmwareOpFromKey is the inverse of firmwareOp.Key, for a name still on the
// target list.
func firmwareOpFromKey(key string) (firmwareOp, bool) {
	rest, ok := strings.CutPrefix(key, firmwareKeyPrefix)
	if !ok {
		return firmwareOp{}, false
	}
	vendor, name, ok := strings.Cut(rest, ":")
	if !ok {
		return firmwareOp{}, false
	}
	for _, t := range firmwareTargets[vendor] {
		if t.Name == name {
			return firmwareOp{Vendor: vendor, Name: t.Name, Value: t.Value}, true
		}
	}
	return firmwareOp{}, false
}

// planFirmwareOps lists the targets to write, in target order: none unless
// the whole layer reads wrong (never when unproven), then each target whose
// current value is not its target value.
func planFirmwareOps(fw *FirmwareReadings) []firmwareOp {
	if fw == nil {
		return nil
	}
	if verdict, _ := evaluateFirmware(fw, map[string]bool{}); verdict != firmwareWrong {
		return nil
	}
	var ops []firmwareOp
	for _, t := range firmwareTargets[fw.Vendor] {
		if s, ok := uniqueSetting(fw, t.Name); ok && s.Value != t.Value {
			ops = append(ops, firmwareOp{Vendor: fw.Vendor, Name: t.Name, Value: t.Value})
		}
	}
	return ops
}

// uniqueSetting returns the setting named name when it is listed exactly once.
func uniqueSetting(fw *FirmwareReadings, name string) (biosconfig.Setting, bool) {
	var found biosconfig.Setting
	n := 0
	for _, s := range fw.Settings {
		if s.Name == name {
			found = s
			n++
		}
	}
	return found, n == 1
}

// firmwareSatisfied reports whether a read shows op's target value.
func firmwareSatisfied(op firmwareOp, fw *FirmwareReadings) bool {
	if fw == nil || fw.Status != FirmwareRead || fw.Vendor != op.Vendor {
		return false
	}
	s, ok := uniqueSetting(fw, op.Name)
	return ok && s.Value == op.Value
}

// firmwareDrifted reports whether a read shows op's setting positively wrong
// again (readable, allowed, not the target).
func firmwareDrifted(op firmwareOp, fw *FirmwareReadings) bool {
	if fw == nil || fw.Status != FirmwareRead || fw.Vendor != op.Vendor {
		return false
	}
	s, ok := uniqueSetting(fw, op.Name)
	return ok && s.Value != op.Value && s.Value != ""
}

// firmwareGranted is gates 1 and 2: the cheap, policy-level conditions.
func firmwareGranted(in ApplyInputs, configure bool) bool {
	return configure && in.FirmwareWrites && in.FirmwareAdapter != nil && in.Firmware != nil &&
		in.FirmwareAdapter.Vendor() == in.Firmware.Vendor
}

// firmwareProtectionReason is gate 4. Only a positively unset password passes.
func firmwareProtectionReason(fw *FirmwareReadings) string {
	switch fw.Protection {
	case biosconfig.ProtectionNone:
		return ""
	case biosconfig.ProtectionSet:
		return reasonFirmwarePasswordSet
	default:
		return reasonFirmwareProtectionUnknown
	}
}

// firmwareWriteAllowed is the last check before any firmware write: the
// password state again, then the BitLocker guard. It reports false and a
// reason on any doubt.
func firmwareWriteAllowed(ctx context.Context, fw *FirmwareReadings, bl BitLockerReaders) (bool, string) {
	if r := firmwareProtectionReason(fw); r != "" {
		return false, r
	}
	return checkBitLocker(ctx, bl)
}

// applyFirmware runs the firmware pass and returns why a wrong setting was not
// written (a protection reason), or "". It reconciles earlier attempts on every
// pass, so state stays honest even while writes are off.
func applyFirmware(ctx context.Context, in ApplyInputs, st *ApplyState, rep *ApplyReport, configure bool, boot string, now time.Time) string {
	fw := in.Firmware
	reconcileFirmware(st, fw, boot)
	clearFirmwareDrift(st, fw)
	if !firmwareGranted(in, configure) {
		return ""
	}
	ops := planFirmwareOps(fw)
	if len(ops) == 0 {
		return ""
	}
	if r := firmwareProtectionReason(fw); r != "" {
		return r
	}
	var due []firmwareOp
	for _, op := range ops {
		if st.Limiter.Allow(op.Key(), now) {
			due = append(due, op)
		}
	}
	stillAllowed := func() bool {
		return ctx.Err() == nil && (in.StillAllowed == nil || in.StillAllowed()) &&
			(in.FirmwareStillAllowed == nil || in.FirmwareStillAllowed())
	}
	if len(due) == 0 || !stillAllowed() {
		return ""
	}
	if ok, reason := firmwareWriteAllowed(ctx, fw, in.BitLocker); !ok {
		return reason
	}

	var attempted []firmwareOp
	for _, op := range due {
		if !stillAllowed() {
			break
		}
		key := op.Key()
		prev, had := st.Limiter.Entries[key]
		st.Limiter.begin(key, now, boot)
		if err := persist(in, *st); err != nil {
			// Fail closed: an attempt that cannot be recorded is not made.
			if had {
				st.Limiter.Entries[key] = prev
			} else {
				delete(st.Limiter.Entries, key)
			}
			log.Warn("firmware setting not applied: attempt could not be persisted", "error", err.Error())
			break
		}
		attempted = append(attempted, op)
		rep.Attempted = append(rep.Attempted, key)
		if err := in.FirmwareAdapter.Apply(ctx, op.Name, op.Value); err != nil {
			rep.Failed[key] = "write_error"
			log.Warn("firmware setting write failed", "setting", key, "error", err.Error())
		}
	}
	if len(attempted) == 0 {
		return ""
	}

	// The adapter drops its cached read on Apply, so this read is fresh.
	after := ReadFirmware(ctx, in.FirmwareAdapter)
	if after == nil || after.Status != FirmwareRead {
		for _, op := range attempted {
			if _, failed := rep.Failed[op.Key()]; !failed {
				rep.Failed[op.Key()] = "readback_unavailable"
			}
		}
		return ""
	}
	rep.Firmware = after
	for _, op := range attempted {
		key := op.Key()
		if _, failed := rep.Failed[key]; failed {
			continue
		}
		if !firmwareSatisfied(op, after) {
			rep.Failed[key] = "readback_mismatch"
			continue
		}
		st.Limiter.succeeded(key)
		setPending(st, key, PendingWrite{At: now, Boot: boot})
	}
	// A write that reported an error but reads back correct (a killed run that
	// landed) is stored, not in effect: pending, like any other.
	reconcileFirmware(st, after, boot)
	return ""
}

// reconcileFirmware handles a firmware attempt that was never confirmed but
// whose value now reads correct. With no reboot since the attempt it is stored
// but not in effect, so it is marked pending as of the attempt.
func reconcileFirmware(st *ApplyState, fw *FirmwareReadings, boot string) {
	if fw == nil {
		return
	}
	for key, e := range st.Limiter.Entries {
		if e.Failures == 0 {
			continue
		}
		op, ok := firmwareOpFromKey(key)
		if !ok || !firmwareSatisfied(op, fw) {
			continue
		}
		if boot == "" || e.Boot == "" || boot == e.Boot {
			setPending(st, key, PendingWrite{At: e.LastAttemptAt, Boot: e.Boot})
		}
		st.Limiter.succeeded(key)
	}
}

// clearFirmwareDrift drops a pending firmware write whose value reads wrong
// again (a BIOS update reset it); the limiter then governs a re-apply.
func clearFirmwareDrift(st *ApplyState, fw *FirmwareReadings) {
	for key := range st.Pending {
		if op, ok := firmwareOpFromKey(key); ok && firmwareDrifted(op, fw) {
			delete(st.Pending, key)
		}
	}
}

// addFirmwareStatus adds firmware failures, blocks and deferrals to the
// status, as statusFor does for Windows settings.
func addFirmwareStatus(s *ApplyStatus, st *ApplyState, fw *FirmwareReadings, now time.Time) {
	for _, op := range planFirmwareOps(fw) {
		key := op.Key()
		switch {
		case st.Limiter.Blocked(key):
			s.Blocked = append(s.Blocked, key)
			s.Failed = append(s.Failed, key)
		case st.Limiter.failures(key) > 0:
			s.Failed = append(s.Failed, key)
		case !st.Limiter.Allow(key, now):
			s.Deferred = append(s.Deferred, key)
		}
	}
	sort.Strings(s.Failed)
	sort.Strings(s.Blocked)
	sort.Strings(s.Deferred)
}

// hasFirmwarePending reports a stored firmware value not yet in effect.
func hasFirmwarePending(pending []string) bool {
	for _, k := range pending {
		if strings.HasPrefix(k, firmwareKeyPrefix) {
			return true
		}
	}
	return false
}
