package executor

import (
	"sort"
	"strings"
)

// #3409 PR4b — value-based output redactor.
//
// SecretRedactionMarker is deliberately generic. A marker naming the variable
// key would CONFIRM which credential the script emitted, to an audience
// (`scripts:read` on the server) wider than the script's author — the leak this
// exists to prevent, minus the characters.
const SecretRedactionMarker = "[REDACTED]"

// BuildSecretRedactor returns a function that removes every literal occurrence
// of the supplied secret values from a text.
//
// Honest scope: this is ACCIDENTAL-LEAK protection, not DLP. It removes a
// credential a script echoed, logged, or included in an error message. It
// cannot catch a value the script transformed, base64-encoded, hashed,
// reversed, or printed one character per line. Treat it as a safety net over
// careless output, never as a control against a hostile script author — who
// holds the credential by definition.
//
// It also runs LAST, after two earlier transforms, and only matches text that
// survived them intact: a secret whose middle is consumed by a SanitizeOutput
// pattern, or one straddling the 1 MB limitedWriter cap (executor.go), can
// leave an unmatched fragment behind. Inherent to redact-last; the alternative
// (redact first) would let the pattern layer re-mangle the markers.
//
// Mirrors apps/api/src/services/exactSecretRedaction.ts (ships in PR4a,
// #3557 — not present on this branch's base yet) so the agent and the server
// produce identical redacted text for the same input.
func BuildSecretRedactor(values []string) func(string) string {
	seen := make(map[string]struct{}, len(values))
	filtered := make([]string, 0, len(values))
	for _, v := range values {
		if len(v) < MinSecretValueLength {
			continue
		}
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		filtered = append(filtered, v)
	}

	if len(filtered) == 0 {
		return func(s string) string { return s }
	}

	return func(text string) string {
		type span struct{ start, end int }

		var spans []span
		for _, v := range filtered {
			offset := 0
			for {
				idx := strings.Index(text[offset:], v)
				if idx < 0 {
					break
				}
				start := offset + idx
				end := start + len(v)
				spans = append(spans, span{start, end})
				// Advance by the match length, not by one, so a value never
				// matches inside its own already-recorded match.
				offset = end
			}
		}

		if len(spans) == 0 {
			return text
		}

		sort.Slice(spans, func(i, j int) bool {
			if spans[i].start != spans[j].start {
				return spans[i].start < spans[j].start
			}
			return spans[i].end < spans[j].end
		})

		merged := spans[:1]
		for _, s := range spans[1:] {
			last := &merged[len(merged)-1]
			// `<` (not `<=`): two ranges that merely ABUT (s.start == last.end)
			// are distinct occurrences and each earns its own marker — mirrors
			// the server's exactSecretRedaction.ts merge condition exactly, so
			// abutting-but-non-overlapping secrets redact to two markers on
			// both ends, not one.
			if s.start < last.end {
				// Genuinely overlapping — extend the current run rather than
				// starting a new one, so they collapse into one marker.
				if s.end > last.end {
					last.end = s.end
				}
				continue
			}
			merged = append(merged, s)
		}

		var b strings.Builder
		b.Grow(len(text))
		cursor := 0
		for _, m := range merged {
			b.WriteString(text[cursor:m.start])
			b.WriteString(SecretRedactionMarker)
			cursor = m.end
		}
		b.WriteString(text[cursor:])

		return b.String()
	}
}
