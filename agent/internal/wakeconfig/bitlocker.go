package wakeconfig

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/security"
)

// The BitLocker guard (W04) decides whether a firmware write is safe for the
// OS volume. A change to firmware configuration is measured into TPM PCR 1, so
// a volume sealed to PCR 1 would ask for its recovery key at the next boot.
// The guard only reads: Breeze never suspends, resumes or changes BitLocker.
//
// It allows a write in exactly two cases, and blocks every other reading:
//   - the volume reads "off" with no error;
//   - the volume reads "on" or "suspended" (a suspension that is not ours may
//     resume before the reboot that applies the setting), at least one TPM
//     protector's PCR validation profile is listed, every profile reads as PCR
//     numbers 0-23, and none of them is PCR 1.
//
// The profile comes from manage-bde's English labels (as bitlockerguard reads
// it), so a localized Windows reads as unreadable and gets no firmware write.

// Reasons the guard blocks a write; reported as readiness reason codes.
const (
	reasonBitLockerStateUnknown      = "bitlocker_state_unknown"
	reasonBitLockerProfileUnreadable = "bitlocker_profile_unreadable"
	reasonBitLockerPCR1              = "bitlocker_pcr1_bound"
)

// bitLockerCheckTimeout bounds the whole check (state read plus manage-bde).
const bitLockerCheckTimeout = 90 * time.Second

const maxPCR = 23

// BitLockerReaders are the guard's two read-only seams.
type BitLockerReaders struct {
	// State reads the OS volume as security.SystemDriveBitLockerState does.
	// Any error makes the reading unknown, even one that comes with "off".
	State func() (string, error)
	// Protectors returns manage-bde's TPM protector listing for the OS volume
	// (-protectors -get <drive> -Type TPM, which never lists a recovery
	// password). The output is parsed, never logged or put in an error.
	Protectors func(ctx context.Context) (string, error)
}

// checkBitLocker reports whether a firmware write is allowed and, when it is
// not, the reason. It fails closed on any error, timeout, panic, missing seam
// or output it does not recognise.
func checkBitLocker(parent context.Context, r BitLockerReaders) (ok bool, reason string) {
	ctx, cancel := context.WithTimeout(parent, bitLockerCheckTimeout)
	defer cancel()
	if ctx.Err() != nil {
		return false, reasonBitLockerStateUnknown
	}
	state, err := readBitLockerState(ctx, r.State)
	if err != nil {
		log.Warn("firmware write blocked: bitlocker state unreadable", "error", err.Error())
		return false, reasonBitLockerStateUnknown
	}
	switch state {
	case security.BitLockerStateOff:
		return true, ""
	case security.BitLockerStateOn, security.BitLockerStateSuspended:
	default:
		log.Warn("firmware write blocked: bitlocker state not recognised")
		return false, reasonBitLockerStateUnknown
	}
	out, err := readProtectors(ctx, r.Protectors)
	if err == nil && ctx.Err() != nil {
		err = ctx.Err() // output that arrived past the deadline is not trusted
	}
	if err != nil {
		log.Warn("firmware write blocked: bitlocker protectors unreadable", "error", err.Error())
		return false, reasonBitLockerProfileUnreadable
	}
	pcr1, err := profilesIncludePCR1(out)
	if err != nil {
		log.Warn("firmware write blocked: bitlocker validation profile unreadable", "error", err.Error())
		return false, reasonBitLockerProfileUnreadable
	}
	if pcr1 {
		log.Info("firmware write blocked: bitlocker is sealed to PCR 1")
		return false, reasonBitLockerPCR1
	}
	return true, ""
}

// readBitLockerState runs the state seam under ctx and recovers a panic. The
// seam takes no context, so a hung read is abandoned at the deadline (its own
// timeout ends it).
func readBitLockerState(ctx context.Context, read func() (string, error)) (string, error) {
	if read == nil {
		return "", fmt.Errorf("no bitlocker state reader")
	}
	type result struct {
		state string
		err   error
	}
	ch := make(chan result, 1)
	go func() {
		defer func() {
			if p := recover(); p != nil {
				ch <- result{err: fmt.Errorf("bitlocker state reader panicked")}
			}
		}()
		s, err := read()
		ch <- result{s, err}
	}()
	select {
	case <-ctx.Done():
		return "", fmt.Errorf("bitlocker state read: %w", ctx.Err())
	case res := <-ch:
		if res.err != nil {
			return "", res.err
		}
		return res.state, nil
	}
}

func readProtectors(ctx context.Context, read func(context.Context) (string, error)) (out string, err error) {
	if read == nil {
		return "", fmt.Errorf("no bitlocker protector reader")
	}
	defer func() {
		if p := recover(); p != nil {
			out, err = "", fmt.Errorf("bitlocker protector reader panicked")
		}
	}()
	return read(ctx)
}

const pcrProfileLabel = "pcr validation profile:"

// profilesIncludePCR1 reads every "PCR Validation Profile:" block; there must
// be exactly one per listed protector ("ID: {...}"). Each must start with a
// list of PCR numbers on the next line; following lines that are
// also bare PCR lists (a wrapped profile) join it. PCRs are compared as
// integers, never substrings. No profile at all is an error. Errors never
// repeat the output.
func profilesIncludePCR1(out string) (bool, error) {
	lines := strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n")
	found, pcr1 := false, false
	// Every listed protector must carry its own profile: a protector whose
	// profile cannot be found is not assumed to be clean.
	protectors, profiles := 0, 0
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "ID:") && strings.Contains(t, "{") {
			protectors++
		}
		if strings.ToLower(t) == pcrProfileLabel {
			profiles++
		}
	}
	if protectors != profiles {
		return false, fmt.Errorf("%d protectors listed but %d validation profiles", protectors, profiles)
	}
	for i, line := range lines {
		if strings.ToLower(strings.TrimSpace(line)) != pcrProfileLabel {
			continue
		}
		found = true
		if i+1 >= len(lines) {
			return false, fmt.Errorf("a validation profile has no PCR list")
		}
		first, err := parsePCRList(lines[i+1])
		if err != nil {
			return false, err
		}
		pcrs := first
		for _, next := range lines[i+2:] {
			more, err := parsePCRList(next)
			if err != nil {
				break // the profile ended
			}
			pcrs = append(pcrs, more...)
		}
		for _, n := range pcrs {
			if n == 1 {
				pcr1 = true
			}
		}
	}
	if !found {
		return false, fmt.Errorf("no validation profile in the output")
	}
	return pcr1, nil
}

// parsePCRList parses "7, 11": comma-separated integers 0-23, at least one.
func parsePCRList(line string) ([]int, error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil, fmt.Errorf("the validation profile is empty")
	}
	var out []int
	for _, field := range strings.Split(line, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(field))
		if err != nil || n < 0 || n > maxPCR {
			return nil, fmt.Errorf("the validation profile is not a list of PCRs")
		}
		out = append(out, n)
	}
	return out, nil
}
