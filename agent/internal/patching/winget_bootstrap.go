package patching

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// bootstrapAction describes what the SYSTEM-context bootstrapper should do
// about winget on this host.
type bootstrapAction int

const (
	actionUseExisting bootstrapAction = iota
	actionProvision
	actionUnavailable
)

// minWingetVersion is the oldest winget release considered fully functional
// for our patching workflows.
const minWingetVersion = "1.6.0.0"

// bootstrapInputs captures the detection results decideBootstrap needs to
// pick an action: whether winget was located (and at what version), the
// minimum acceptable version, and whether the Appx provisioning stack
// (needed to install/repair the DesktopAppInstaller package) is available.
type bootstrapInputs struct {
	locatedVersion   string
	located          bool
	minVersion       string
	appxStackPresent bool
}

// decideBootstrap is pure decision logic over detection results: given what
// was found on disk plus whether the Appx stack can provision a fresh
// winget, decide whether to use the existing install, provision one, or
// report winget as unavailable.
func decideBootstrap(in bootstrapInputs) bootstrapAction {
	upToDate := in.located && compareVersions(in.locatedVersion, in.minVersion) >= 0
	if upToDate {
		return actionUseExisting
	}
	if in.appxStackPresent {
		return actionProvision
	}
	if in.located {
		return actionUseExisting // old winget beats nothing
	}
	return actionUnavailable
}

// artifactRef identifies a single pinned bootstrap artifact: its logical
// name (for error messages), the expected SHA-256 hex digest, and the path
// to GET it from relative to the Breeze API base URL.
type artifactRef struct {
	Name   string
	SHA256 string
	Path   string
}

// verifySHA256 checks data against the expected hex-encoded SHA-256 digest.
func verifySHA256(data []byte, wantHex string) error {
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, wantHex) {
		return fmt.Errorf("sha256 mismatch: got %s want %s", got, wantHex)
	}
	return nil
}

// fetchArtifact GETs baseURL+ref.Path and verifies the response body's
// SHA-256 against ref.SHA256 before returning it.
func fetchArtifact(client *http.Client, baseURL string, ref artifactRef) ([]byte, error) {
	resp, err := client.Get(strings.TrimRight(baseURL, "/") + ref.Path)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", ref.Name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: status %d", ref.Name, resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", ref.Name, err)
	}
	if err := verifySHA256(data, ref.SHA256); err != nil {
		return nil, fmt.Errorf("verify %s: %w", ref.Name, err)
	}
	return data, nil
}
