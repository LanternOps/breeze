package heartbeat

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
	"github.com/breeze-rmm/agent/internal/isolation"
	"github.com/breeze-rmm/agent/internal/isolation/recoveryinstall"
	"github.com/breeze-rmm/agent/internal/updater"
)

// recoveryComponent is the updater component that distributes the network
// isolation recovery executable (release asset
// breeze-isolation-recovery-<os>-<arch>[.exe]).
const recoveryComponent = "isolation-recovery"

// recoveryDownloader is the slice of *updater.Updater the recovery wiring uses.
// Every method makes the updater's full signed-manifest trust decision.
type recoveryDownloader interface {
	DownloadBinary(version string) (string, error)
	VerifiedDownloadEnvelope(version string) (updater.ReleaseEnvelope, error)
	VerifiedReleaseAssetSHA256(manifest, signatureB64, signingKeyID, version, assetName string) (string, error)
}

// recoveryUpdaterConfig is the ordinary signed-manifest updater for the
// isolation-recovery component, carrying the agent's live trust settings.
func recoveryUpdaterConfig(h *Heartbeat) *updater.Config {
	return &updater.Config{
		ServerURL:                   h.serverURL,
		BackupServerURL:             h.backupServerURL(),
		AuthToken:                   h.secureToken,
		CurrentVersion:              h.agentVersion,
		Component:                   recoveryComponent,
		PinnedManifestPubKeys:       h.pinnedManifestPubKeys(),
		RequireManifestSigningKeyID: h.requireManifestSigningKeyID(),
	}
}

// recoverySelfHostEdition is the updater's edition signal: only a build without
// an enforced host allowlist is self-host. recoveryinstall re-checks it too.
func recoverySelfHostEdition() bool { return !hostpolicy.Enforced() }

// recoveryDistribution builds the recovery executable's trust Path B and its
// download adapters. newDownloader is called per use so a rotated pinned key
// or a changed server URL takes effect without a restart.
func recoveryDistribution(newDownloader func() recoveryDownloader, selfHost bool) (recoveryinstall.ManifestTrust, isolation.RecoverySource) {
	trust := recoveryinstall.ManifestTrust{
		SelfHostEdition: selfHost,
		ManifestDigest: func(env recoveryinstall.ManifestEnvelope, version, asset string) (string, error) {
			return newDownloader().VerifiedReleaseAssetSHA256(env.Manifest, env.Signature, env.SigningKeyID, version, asset)
		},
	}
	src := isolation.RecoverySource{
		Fetch: func(ctx context.Context, version string, w io.Writer) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			// DownloadBinary verifies the manifest signature, the asset entry
			// and the downloaded SHA-256 before it returns a path.
			path, err := newDownloader().DownloadBinary(version)
			if err != nil {
				return fmt.Errorf("download isolation recovery %s: %w", version, err)
			}
			defer func() { _ = os.Remove(path) }()
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			defer func() { _ = f.Close() }()
			_, err = io.Copy(w, f)
			return err
		},
		FetchEnvelope: func(ctx context.Context, version string) (recoveryinstall.ManifestEnvelope, error) {
			if err := ctx.Err(); err != nil {
				return recoveryinstall.ManifestEnvelope{}, err
			}
			env, err := newDownloader().VerifiedDownloadEnvelope(version)
			if err != nil {
				return recoveryinstall.ManifestEnvelope{}, err
			}
			return recoveryinstall.ManifestEnvelope{Manifest: env.Manifest, Signature: env.Signature, SigningKeyID: env.SigningKeyID}, nil
		},
	}
	return trust, src
}

// configureRecoveryDistribution wires the production recovery installer into a
// scheduler that supports it (Windows). Other platforms ignore both calls.
func (h *Heartbeat) configureRecoveryDistribution(scheduler isolation.RecoveryScheduler) {
	trust, src := recoveryDistribution(func() recoveryDownloader { return updater.New(recoveryUpdaterConfig(h)) }, recoverySelfHostEdition())
	isolation.ConfigureRecoveryManifestTrust(scheduler, trust)
	isolation.ConfigureRecoverySource(scheduler, src)
}
