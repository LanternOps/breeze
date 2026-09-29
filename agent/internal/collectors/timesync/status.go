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
	// Branch B: only proven numeric tokens, then event insertion strings.
	tokens := unknownStatus()
	if raw, e := sys.W32tmStatus(ctx); e == nil {
		tokens = parseW32tmTokens(string(raw))
	}
	best := unknownStatus()
	for _, e := range events {
		if e.EventID != 35 && e.EventID != 37 {
			continue
		}
		if best.LastSuccessfulSyncAt != nil && !e.OccurredAt.After(*best.LastSuccessfulSyncAt) {
			continue
		}
		src, kind := eventSource(e)
		if src == "" {
			continue
		}
		best = Status{Method: "events", Source: ptr(src), SourceKind: kind, LastSuccessfulSyncAt: ptr(e.OccurredAt.UTC())}
	}
	if tokens.Source != nil {
		tokens.Method = "w32tm_tokens"
		if best.Source != nil && strings.EqualFold(*best.Source, *tokens.Source) {
			tokens.LastSuccessfulSyncAt = best.LastSuccessfulSyncAt
		}
		return tokens
	}
	if tokens.Stratum != nil {
		best.Stratum = tokens.Stratum
	}
	if tokens.PollIntervalSeconds != nil {
		best.PollIntervalSeconds = tokens.PollIntervalSeconds
	}
	return best
}
