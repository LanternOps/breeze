package agentapp

import "log/slog"

// siteIDDeprecationNotice is shown when `enroll --site-id` is used. The flag
// was never read: the server derives the site from the enrollment key (#8474).
// It stays registered (hidden, deprecated) so install scripts that still pass
// it don't fail with "unknown flag"; a follow-up issue removes it.
const siteIDDeprecationNotice = "--site-id is ignored; the site comes from the enrollment key. The flag will be removed in a future release."

// warnIgnoredSiteID records the deprecation in agent diagnostics. Cobra's own
// notice goes to stderr only, which unattended installs usually discard.
func warnIgnoredSiteID(log *slog.Logger, siteID string) {
	if siteID == "" {
		return
	}
	log.Warn(siteIDDeprecationNotice, "ignoredSiteId", siteID)
}
