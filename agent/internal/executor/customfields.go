package executor

import (
	"encoding/json"
	"strings"
)

// CustomFieldMarker is the stdout sentinel a script uses to write its own
// device's custom fields (#2698). Must stay byte-identical to
// CUSTOM_FIELD_MARKER in
// apps/api/src/services/customFields/scriptWriteMarkers.ts.
const CustomFieldMarker = "::breeze:custom-fields::"

const (
	maxCustomFieldMarkerLines = 20
	maxCustomFieldKeys        = 50
	maxCustomFieldJSONBytes   = 8192
)

// ExtractCustomFields pulls every well-formed marker line out of RAW stdout —
// deliberately before SanitizeOutput, which rewrites `token=`/`secret=`-shaped
// substrings and would otherwise corrupt a marker beyond JSON.Unmarshal's
// reach. Returns the merged map (later lines win) and stdout with the consumed
// lines removed.
//
// All three caps (marker-line count, per-marker JSON size, distinct key
// count) reject at LINE granularity and leave the rejected line in the
// returned stdout, so a technician reading the persisted output can always
// see which lines were not applied and why (a syntactically valid marker line
// is never partially merged then silently discarded key-by-key — that would
// leave no trace anywhere once the line itself is consumed). This also keeps
// "later lines win" true without exception: a later line either fully applies
// or is fully rejected, never partially applies past the key cap.
func ExtractCustomFields(stdout string) (map[string]any, string) {
	if !strings.Contains(stdout, CustomFieldMarker) {
		return nil, stdout
	}

	lines := strings.Split(stdout, "\n")
	kept := make([]string, 0, len(lines))
	var fields map[string]any
	markerLines := 0

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, CustomFieldMarker) || markerLines >= maxCustomFieldMarkerLines {
			kept = append(kept, line)
			continue
		}

		payload := strings.TrimSpace(strings.TrimPrefix(trimmed, CustomFieldMarker))
		if len(payload) > maxCustomFieldJSONBytes {
			kept = append(kept, line)
			continue
		}

		var parsed map[string]any
		if err := json.Unmarshal([]byte(payload), &parsed); err != nil || parsed == nil {
			kept = append(kept, line)
			continue
		}

		// Reject the whole line, deterministically, if merging it would push
		// the distinct-key count past the cap — rather than partially merging
		// some of its keys in Go's randomized map-iteration order and dropping
		// the rest with no trace.
		newKeys := 0
		for k := range parsed {
			if _, exists := fields[k]; !exists {
				newKeys++
			}
		}
		if len(fields)+newKeys > maxCustomFieldKeys {
			kept = append(kept, line)
			continue
		}

		markerLines++
		if fields == nil {
			fields = make(map[string]any, len(parsed))
		}
		for k, v := range parsed {
			fields[k] = v
		}
		// consumed: not appended to kept
	}

	return fields, strings.Join(kept, "\n")
}
