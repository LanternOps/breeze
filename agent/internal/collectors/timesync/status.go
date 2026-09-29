package timesync

import (
	"context"
	"strings"
)

// parseW32tmTokens is the token-disabled variant. The Task 1 spike proved
// the w32tm /query /status /verbose line layout on English Server 2022 only;
// the German (L9) and Windows 10 / Server 2016 floor comparisons are owed, so
// no position-based numeric field and no localized source or date line is
// read. Enable position parsing only with that evidence.
func parseW32tmTokens(raw string) Status { return unknownStatus() }

func eventSource(e Event) (string, string) {
	if len(e.Properties) == 0 {
		return "", "unknown"
	}
	raw := strings.TrimSpace(e.Properties[0])
	kind := "unknown"
	if i := strings.Index(raw, " ("); i >= 0 {
		suffix := strings.ToLower(raw[i:])
		switch {
		case strings.HasPrefix(suffix, " (ntp.m|"):
			kind = "ntp_peer"
		case strings.HasPrefix(suffix, " (ntp.d|"):
			kind = "domain_peer"
		default:
			return "", "unknown"
		}
		raw = raw[:i]
	}
	raw = peerFlags.ReplaceAllString(raw, "")
	if !IsValidNtpServerHost(raw) {
		return "", "unknown"
	}
	return raw, kind
}

func validKind(k string) bool {
	switch k {
	case "ntp_peer", "domain_peer", "local_clock", "free_running", "vm_host", "unknown":
		return true
	}
	return false
}

func readStatus(ctx context.Context, sys System, events []Event) Status {
	// Branch A: usable structured provider status wins; a failure takes Branch B.
	native, err := sys.ProviderStatus(ctx)
	if err == nil && native.Source != nil && strings.TrimSpace(*native.Source) != "" {
		native.Source = nullableText(*native.Source, 512)
		native.Method = "provider_api"
		if !validKind(native.SourceKind) {
			native.SourceKind = "unknown"
		}
		if native.LastSyncError != nil {
			native.LastSyncError = nullableText(*native.LastSyncError, 512)
		}
		if native.Stratum != nil && (*native.Stratum < 0 || *native.Stratum > 16) {
			native.Stratum = nil
		}
		return native
	}
	// Branch B: only proven numeric tokens, then the newest event 35.
	tokens := unknownStatus()
	if raw, e := sys.W32tmStatus(ctx); e == nil {
		tokens = parseW32tmTokens(string(raw))
	}
	if tokens.Source != nil {
		tokens.Method = "w32tm_tokens"
		return tokens
	}
	best := eventStatus(events)
	if tokens.Stratum != nil {
		best.Stratum = tokens.Stratum
	}
	if tokens.PollIntervalSeconds != nil {
		best.PollIntervalSeconds = tokens.PollIntervalSeconds
	}
	return best
}

// eventStatus reads the source from the newest event 35 ("now synchronizing
// with"), the only event that names the chosen source. Event 37 names a peer
// that is receiving data: on a Hyper-V guest NtpClient keeps emitting 37 for
// its peer while VMICTimeProvider is the active source (Task 1 spike), so a
// 37 is never a source witness. If the newest 35 is not host(+flags) — for
// example the VM IC provider's display name — the source is unknown; an
// older 35 is not a fallback, because it no longer names the chosen source.
//
// LastSuccessfulSyncAt stays nil: 35/37 fire on service start and source
// change, not on every sync (lab VM history clusters at reboots with gaps of
// up to three weeks while in sync), so their time would raise a false
// sync_stale. The events stay in the snapshot's event list, where the server
// uses them as success signals (spec §5.3, §14 "last sync unknown").
func eventStatus(events []Event) Status {
	var newest *Event
	for i := range events {
		e := &events[i]
		if e.EventID != 35 {
			continue
		}
		if newest == nil || e.OccurredAt.After(newest.OccurredAt) ||
			(e.OccurredAt.Equal(newest.OccurredAt) && e.RecordID > newest.RecordID) {
			newest = e
		}
	}
	if newest == nil {
		return unknownStatus()
	}
	src, kind := eventSource(*newest)
	if src == "" {
		return unknownStatus()
	}
	return Status{Method: "events", Source: ptr(src), SourceKind: kind}
}
