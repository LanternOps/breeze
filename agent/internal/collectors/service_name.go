package collectors

import "github.com/breeze-rmm/agent/internal/branding"

// parseServiceName extracts the service name from an SCM message, falling
// back to fallback (typically entry.Source) if there is no match. A branded
// service is reported under its fixed name (see branding.CanonicalServiceName)
// so the API still recognises our own service failures; with no brand
// configured the result is exactly what parseRawServiceName returns.
func parseServiceName(message, fallback string) string {
	return branding.CanonicalServiceName(parseRawServiceName(message, fallback))
}
