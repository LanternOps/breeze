package wakeconfig

import (
	"context"
	"errors"
	"slices"

	"github.com/breeze-rmm/agent/internal/biosconfig"
)

// Firmware read outcomes, also reported as details.firmware.
const (
	FirmwareRead                 = "read"
	FirmwareInterfaceUnavailable = "interface_unavailable"
	FirmwareUnreadable           = "unreadable"
)

// FirmwareReadings is the firmware layer of one collection, read through a
// biosconfig adapter before Compute runs (Compute does no I/O).
type FirmwareReadings struct {
	Vendor     string
	Status     string // FirmwareRead | FirmwareInterfaceUnavailable | FirmwareUnreadable
	Settings   []biosconfig.Setting
	Protection biosconfig.Protection
}

// ReadFirmware reads settings and protection through the adapter. A nil
// adapter (no firmware support for this make) gives nil. A failed read never
// fails the collection: it is reported as a status, so the Windows layer still
// uploads. A failed protection read is ProtectionUnknown.
func ReadFirmware(ctx context.Context, a biosconfig.Adapter) *FirmwareReadings {
	if a == nil {
		return nil
	}
	fw := &FirmwareReadings{Vendor: a.Vendor(), Status: FirmwareRead, Protection: biosconfig.ProtectionUnknown}
	settings, err := a.Read(ctx)
	switch {
	case errors.Is(err, biosconfig.ErrInterfaceUnavailable):
		fw.Status = FirmwareInterfaceUnavailable
		return fw
	case err != nil:
		if ctx.Err() == nil {
			log.Warn("firmware settings read failed", "vendor", fw.Vendor, "error", err.Error())
		}
		fw.Status = FirmwareUnreadable
		return fw
	}
	fw.Settings = settings
	if p, err := a.Protection(ctx); err == nil {
		fw.Protection = p
	} else if ctx.Err() == nil {
		log.Warn("firmware protection read failed", "vendor", fw.Vendor, "error", err.Error())
	}
	return fw
}

// firmwareVerdict is the firmware layer's contribution to readiness.
type firmwareVerdict int

const (
	firmwareOK       firmwareVerdict = iota // every target read and correct
	firmwareWrong                           // a target is readable, writable and wrong
	firmwareUnproven                        // cannot be judged: no adapter, unread, unrecognised
)

// evaluateFirmware judges the firmware layer and adds its reason codes. It
// never guesses: a missing name or a target value the model does not allow
// makes the whole layer unproven, even if another target is wrong.
func evaluateFirmware(fw *FirmwareReadings, reasons map[string]bool) (firmwareVerdict, map[string]string) {
	if fw == nil {
		// The caller adds firmware_adapter_unavailable only when nothing else
		// is wrong, as before this make had an adapter.
		return firmwareUnproven, nil
	}
	switch fw.Status {
	case FirmwareRead:
	case FirmwareInterfaceUnavailable:
		reasons["firmware_interface_unavailable"] = true
		return firmwareUnproven, nil
	default:
		reasons["firmware_unreadable"] = true
		return firmwareUnproven, nil
	}
	targets := firmwareTargets[fw.Vendor]
	if len(targets) == 0 {
		reasons["firmware_setting_unrecognised"] = true
		return firmwareUnproven, nil
	}
	byName := make(map[string]biosconfig.Setting, len(fw.Settings))
	count := make(map[string]int, len(fw.Settings))
	for _, s := range fw.Settings {
		byName[s.Name] = s
		count[s.Name]++
	}
	current := make(map[string]string, len(targets))
	unproven := false
	var wrong []string
	for _, t := range targets {
		s, ok := byName[t.Name]
		if !ok || count[t.Name] > 1 {
			// Missing, or listed more than once (ambiguous): not guessed.
			reasons["firmware_setting_unrecognised"] = true
			unproven = true
			continue
		}
		current[t.Name] = s.Value
		if !slices.Contains(s.Allowed, t.Value) {
			reasons["firmware_value_not_allowed"] = true
			unproven = true
			continue
		}
		if !slices.Contains(s.Allowed, s.Value) {
			// Empty or outside the model's own list: not really read.
			reasons["firmware_value_unrecognised"] = true
			unproven = true
			continue
		}
		if s.Value != t.Value {
			wrong = append(wrong, t.Reason)
		}
	}
	if unproven {
		return firmwareUnproven, current
	}
	if len(wrong) > 0 {
		for _, r := range wrong {
			reasons[r] = true
		}
		return firmwareWrong, current
	}
	return firmwareOK, current
}
