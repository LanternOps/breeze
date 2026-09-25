package heartbeat

// helperOfferSink is the part of *helper.Manager that consumes the heartbeat's
// helper version offer.
type helperOfferSink interface {
	InstalledVersion() string
	IsInstalled() bool
	CheckUpdate(targetVersion string)
	WithdrawOffer()
}

// applyHelperOffer hands the heartbeat's helperUpgradeTo to the helper manager.
//
// An empty offer is a withdrawal (#6927): the server sends helperUpgradeTo on
// every heartbeat while it wants a helper installed or updated, and stops when
// it has no helper build for the device or no longer wants the change. Without
// the withdrawal a stale pending version kept driving download + msiexec every
// heartbeat (download info 404 after the helper row was deleted).
func applyHelperOffer(mgr helperOfferSink, target string) {
	if target == "" {
		mgr.WithdrawOffer()
		return
	}
	installedHelper := mgr.InstalledVersion()
	installedOnDisk := mgr.IsInstalled()
	if allowed, reason := helperUpgradeAllowed(target, installedHelper, installedOnDisk); !allowed {
		// SECURITY: never auto-downgrade the helper. The signed manifest
		// only binds manifest.Release == requested version, so a
		// compromised/MITM'd control plane could replay an older,
		// validly-signed, known-vulnerable helper release.
		// installedOnDisk distinguishes a genuine downgrade directive from
		// "binary present but its version unreadable" (#6252), which
		// otherwise looks identical in the log.
		log.Error("SECURITY: refusing server-directed helper update",
			"installedVersion", installedHelper,
			"installedOnDisk", installedOnDisk,
			"targetVersion", target,
			"reason", reason)
		return
	}
	mgr.CheckUpdate(target)
}
