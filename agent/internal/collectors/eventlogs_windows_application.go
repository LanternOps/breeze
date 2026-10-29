package collectors

// This file intentionally carries no build constraint ("application" is not a
// GOOS/GOARCH, so Go's filename matching does not apply) so the Windows
// Application-log query construction can be unit-tested on macOS/Linux CI.

import (
	"bytes"
	"fmt"
	"strings"
)

// winEventFilterStdout returns the part of a Get-WinEvent command result to
// parse, or nil. A non-zero exit is expected when no events match (empty stdout)
// or a ProviderName is not registered on the host (NoMatchingProvidersFound).
// Registered providers' events can still be on stdout, so exit status alone
// must not discard it. Timeouts and oversize output arrive as nil output.
func winEventFilterStdout(output []byte, runErr error) []byte {
	if len(bytes.TrimSpace(output)) == 0 {
		return nil
	}
	return output
}

// applicationInfoProviderAllowlist lists the Application-log providers whose
// Warning and Information events the Windows agent collects (#8174). Every
// other provider is collected at Error/Critical only: shipping all
// Information events would be far too much volume. Collected events still pass
// the collector's server-configured minimumLevel filter (default "info"), so a
// policy minimum of "warning" drops their Information events; "error" or higher
// drops all of them.
//
// Keep this list small and add a provider only for a specific use case.
// MsiInstaller covers install/uninstall (1033/1034, 11707/11724).
// APCPBEAgent (APC PowerChute Business Edition): all of its Warning and Information
// events; the motivating case is UPS alerts such as "UPS On Battery"
// (EventID 2000, Warning; #10493).
//
// The API warns at rule save when an event_log rule targets an Information-
// or Warning-level Application source outside this list. Its copy lives in
// packages/shared/src/validators/eventLogProviders.ts; keep it and the provider list in
// apps/docs/src/content/docs/features/event-log-forwarding.mdx in sync with this list.
// apps/api/src/services/eventLogProviderAllowlistParity.test.ts checks Go/shared parity only.
var applicationInfoProviderAllowlist = []string{
	"MsiInstaller",
	"APCPBEAgent",
}

// applicationInfoEventsFilterHashtable builds the Get-WinEvent
// -FilterHashtable body for allowlisted Application providers at Warning (3)
// and Information (4) levels. Levels 1-2 are already returned by the
// all-provider Application query, so the two queries never overlap and the
// existing RecordId-based EventID dedup is unaffected.
func applicationInfoEventsFilterHashtable(sinceRFC3339 string) string {
	providers := make([]string, 0, len(applicationInfoProviderAllowlist))
	for _, p := range applicationInfoProviderAllowlist {
		providers = append(providers, "'"+p+"'")
	}
	return fmt.Sprintf(
		"LogName='Application'; ProviderName=%s; Level=3,4; StartTime='%s'",
		strings.Join(providers, ","), sinceRFC3339,
	)
}
