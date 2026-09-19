package updater

import (
	"strings"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// editionAllowed reports whether a release artifact manifest asset entry may
// be applied to this running build, based on its optional "edition" field.
//
// An ABSENT edition (assetEdition == "") is always accepted: it covers both
// manifests predating the edition field (back-compat) and the fact that an
// agent built before this check existed never calls editionAllowed at all,
// so old agents can still upgrade cleanly into edition-stamped manifests.
//
// A non-empty edition is accepted one-way (#4072):
//
//   - A hosted build (hostpolicy.Enforced(), allowlist-injected) accepts ONLY
//     "hosted". Accepting a "self-host" artifact would swap the running binary
//     for one with no host-policy allowlist — enforcement removal — so that
//     direction stays a hard refusal.
//
//   - A self-host build (the unrestricted repo-default) accepts "self-host"
//     AND "hosted". Both call sites consult editionAllowed strictly AFTER the
//     manifest's Ed25519 signature verified against the trust roots, and a
//     hosted build only ADDS enforcement, so the transition grants nothing an
//     attacker could not already get from a signed self-host manifest. Without
//     this, a self-host build whose control plane cut over to hosted-edition
//     artifacts wedges in a permanent download-refusal loop with no
//     server-side escape hatch (agents 0.105.0–0.106.x in the field).
//
//     Accepted residual risk: a control plane that substitutes a signed
//     STRICT-hostpolicy hosted artifact for a self-hoster's update can move
//     the agent onto a build that refuses the self-hoster's own server URL,
//     losing management connectivity. That requires a malicious or
//     compromised control plane — which can already run arbitrary scripts on
//     enrolled devices — so the transition adds no new attacker capability;
//     server-side, offers are edition-scoped to the deployment's own edition
//     (apps/api resolvePinnedUpgradeTarget), so a healthy self-host server
//     never offers one.
//
// Any other value — including a typo or a future edition this build predates —
// fails closed rather than being silently accepted.
func editionAllowed(assetEdition string) bool {
	assetEdition = strings.TrimSpace(assetEdition)
	if assetEdition == "" {
		return true
	}
	if hostpolicy.Enforced() {
		return assetEdition == "hosted"
	}
	switch assetEdition {
	case "self-host":
		return true
	case "hosted":
		// One-way self-host → hosted transition. Logged at Warn because the
		// log shipper's default MinLevel is warn (config.go) — Info would
		// exist only in the device-local file, and if the transitioned build
		// ever loses management connectivity (the documented residual risk
		// above), server-side logs are the only forensic record of when the
		// transition happened. Fires at most once per component transition,
		// and only via a signature-verified manifest.
		log.Warn("accepting hosted-edition update artifact from this self-host build (one-way edition transition)")
		return true
	default:
		return false
	}
}
