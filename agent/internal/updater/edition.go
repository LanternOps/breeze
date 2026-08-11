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
// A non-empty edition must match this build's own edition family: "hosted"
// when hostpolicy.Enforced() (an allowlist-injected hosted build), or
// "self-host" when it is not (the unrestricted repo-default build). Any
// other value — including a typo or a future edition this build predates —
// fails closed rather than being silently accepted.
func editionAllowed(assetEdition string) bool {
	assetEdition = strings.TrimSpace(assetEdition)
	if assetEdition == "" {
		return true
	}
	if hostpolicy.Enforced() {
		return assetEdition == "hosted"
	}
	return assetEdition == "self-host"
}
