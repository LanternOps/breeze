package sessionbroker

// boolPtrString renders a tri-state *bool for logs: "true", "false", or
// "unknown" when nil. Logging the pointer directly prints an address.
func boolPtrString(b *bool) string {
	if b == nil {
		return "unknown"
	}
	if *b {
		return "true"
	}
	return "false"
}
