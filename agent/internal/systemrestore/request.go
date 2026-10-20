package systemrestore

// PayloadKey is the command-payload key the server stamps the request under.
const PayloadKey = "restorePoint"

// SupportedVersion is the only Request.Version this agent understands. A newer
// block is ignored rather than half-honoured, so the server can add a v2 shape
// without an old agent misreading it.
const SupportedVersion = 1

// ParseRequest reads the server-stamped restore-point block off a command
// payload and decides whether to attempt a checkpoint.
//
// legacyDefaultEnabled encodes the mixed-fleet protocol contract (#4609):
// a MISSING block on install_patches means legacy best-effort enabled (pass
// true), while a missing block on script / software_install means disabled
// (pass false). An old server that stamps nothing therefore keeps exactly
// today's behaviour on every path. A block whose version this agent does not
// understand is treated the same as a missing one.
//
// The second return value is authoritative. The returned Request is
// zero-valued when no usable block was present.
func ParseRequest(payload map[string]any, legacyDefaultEnabled bool) (Request, bool) {
	raw, ok := payload[PayloadKey].(map[string]any)
	if !ok {
		return Request{}, legacyDefaultEnabled
	}

	v, ok := raw["v"].(float64)
	if !ok || v != SupportedVersion {
		return Request{}, legacyDefaultEnabled
	}

	// A non-boolean "enabled" is a malformed block, read as disabled: an
	// explicit block exists, so the server made a decision we cannot parse,
	// and "do nothing" is the conservative reading.
	enabled, _ := raw["enabled"].(bool)
	req := Request{
		Version:        SupportedVersion,
		RequestID:      stringField(raw, "requestId"),
		Enabled:        enabled,
		Label:          stringField(raw, "label"),
		ResolvedAt:     stringField(raw, "resolvedAt"),
		PolicyRevision: stringField(raw, "policyRevision"),
		ValidUntil:     stringField(raw, "validUntil"),
	}
	return req, enabled
}

func stringField(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}
