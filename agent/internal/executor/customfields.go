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
// lines removed. Unparseable marker lines are LEFT IN stdout so the operator
// can see what the script actually printed.
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

		markerLines++
		if fields == nil {
			fields = make(map[string]any, len(parsed))
		}
		for k, v := range parsed {
			if len(fields) >= maxCustomFieldKeys {
				if _, exists := fields[k]; !exists {
					continue
				}
			}
			fields[k] = v
		}
		// consumed: not appended to kept
	}

	return fields, strings.Join(kept, "\n")
}
