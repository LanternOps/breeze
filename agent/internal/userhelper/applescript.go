package userhelper

// Untagged so the osascript builders (consent_dialog_spec.go) can be tested on
// every OS; only the darwin files run osascript.

// escapeAppleScript escapes a string for safe embedding in an AppleScript
// double-quoted string. Handles quotes, backslashes, and control characters
// that could break out of the string context.
func escapeAppleScript(s string) string {
	result := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case ch == '"':
			result = append(result, '\\', '"')
		case ch == '\\':
			result = append(result, '\\', '\\')
		case ch == '\n':
			result = append(result, '\\', 'n')
		case ch == '\r':
			result = append(result, '\\', 'r')
		case ch == '\t':
			result = append(result, '\\', 't')
		case ch < 0x20 || ch == 0x7f:
			// Strip other control characters
			continue
		default:
			result = append(result, ch)
		}
	}
	return string(result)
}
