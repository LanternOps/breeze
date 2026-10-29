package collectors

// This file intentionally carries no build constraint ("application" is not a
// GOOS/GOARCH, so Go's filename matching does not apply) so the Windows
// Application-log query construction can be unit-tested on macOS/Linux CI.

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
