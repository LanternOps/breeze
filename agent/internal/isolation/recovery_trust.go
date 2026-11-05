package isolation

import (
	"errors"

	"github.com/breeze-rmm/agent/internal/isolation/recoveryinstall"
)

const (
	// reasonRecoveryUntrusted: the recovery executable passed neither the code
	// signature nor (self-host only) the signed-manifest hash check.
	reasonRecoveryUntrusted = "recovery_untrusted"
	// readyDetailManifestHash is the capability detail of a device made ready
	// through trust Path B, so the console can show "self-host (manifest hash)".
	readyDetailManifestHash = "self_host_manifest_hash"
)

// ConfigureRecoveryManifestTrust enables trust Path B (the self-host
// signed-manifest hash, see recoveryinstall.TrustPolicy) on a scheduler that
// supports it: Windows only. Other schedulers ignore it. Call it at agent
// startup, before readiness is configured. The recovery binary never calls it,
// and it never arms tasks, so it keeps Path A only.
//
// The production wiring passes SelfHostEdition: !hostpolicy.Enforced() and a
// ManifestDigest bound to updater.(*Updater).VerifiedReleaseAssetSHA256 with
// the agent's pinned manifest keys. An empty AssetName defaults to the
// agent's own release asset.
func ConfigureRecoveryManifestTrust(s RecoveryScheduler, m recoveryinstall.ManifestTrust) {
	if c, ok := s.(interface {
		configureManifestTrust(recoveryinstall.ManifestTrust)
	}); ok {
		c.configureManifestTrust(m)
	}
}

// schedulerReadiness reports the scheduler's readiness with the trust path
// that accepted the recovery executable, when the scheduler knows it.
func schedulerReadiness(s RecoveryScheduler) func() (recoveryinstall.TrustPath, error) {
	if t, ok := s.(interface {
		recoveryReadiness() (recoveryinstall.TrustPath, error)
	}); ok {
		return t.recoveryReadiness
	}
	return func() (recoveryinstall.TrustPath, error) {
		if ok, why := s.Ready(); !ok {
			return "", errors.New(why)
		}
		return "", nil
	}
}

// readinessFromProbe assembles one readiness probe. A trust refusal from the
// scheduler reports recovery_untrusted rather than scheduler_unavailable.
func readinessFromProbe(engineErr, recoveryErr error, scheduler func() (recoveryinstall.TrustPath, error)) readinessInputs {
	trust, err := scheduler()
	in := readinessInputs{engineErr: engineErr, recoveryErr: recoveryErr, schedulerReady: err == nil, recoveryTrust: trust}
	if err != nil {
		in.schedulerReason = err.Error()
		in.schedulerUntrusted = errors.Is(err, recoveryinstall.ErrUntrusted)
		in.recoveryTrust = ""
	}
	return in
}
