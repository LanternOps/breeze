package updater

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/breeze-rmm/agent/internal/netpolicy"
)

// pkgDownloadURLs lists, in the order to try them, where the macOS .pkg for
// version is downloaded from.
//
// The control plane comes first. The signed manifest that supplies the
// expected checksum comes from the control plane, and on a hosted deployment
// it lists that deployment's own .pkg, which is a different file from the
// public GitHub release asset. Downloading only from GitHub therefore never
// matched on hosted Macs, every update fell back to binary replacement, and
// the package's postinstall never ran on an update. The control plane's
// /api/v1/agents/download/darwin/<arch>/pkg route serves the package that
// belongs to its own manifest in every binary-source mode.
//
// The GitHub release asset stays as the second source, for control planes that
// cannot serve the package (an older server, or one whose package is
// unavailable). Whichever source is used, the bytes are only installed when
// they match the signed checksum.
func pkgDownloadURLs(serverURL, version, goarch string) []string {
	tag := version
	if !strings.HasPrefix(tag, "v") {
		tag = "v" + tag
	}
	release := fmt.Sprintf("https://github.com/LanternOps/breeze/releases/download/%s/breeze-agent-darwin-%s.pkg", tag, goarch)

	base := strings.TrimRight(strings.TrimSpace(serverURL), "/")
	if base == "" {
		return []string{release}
	}
	return []string{
		fmt.Sprintf("%s/api/v1/agents/download/darwin/%s/pkg", base, goarch),
		release,
	}
}

// fetchVerifiedPkg downloads the .pkg from each URL in turn and returns the
// path of the first download whose SHA-256 equals expectedSHA256. The caller
// owns (and must remove) the returned file. A source that fails, or whose bytes
// do not match, is discarded and the next one is tried. When none match the
// error names every source's failure, and no file is left behind.
//
// No Authorization header is sent: the control-plane route is public, and the
// agent's credential must never be sent to the release host.
func (u *Updater) fetchVerifiedPkg(urls []string, expectedSHA256 string) (string, error) {
	if expectedSHA256 == "" {
		return "", fmt.Errorf("refusing to download .pkg without a signed checksum")
	}
	if err := u.checkClient(); err != nil {
		return "", err
	}
	var errs []error
	for _, rawURL := range urls {
		path, err := u.downloadPkgFrom(rawURL)
		if err == nil {
			err = u.verifyChecksum(path, expectedSHA256)
			if err == nil {
				return path, nil
			}
			removeCleanup(path)
		}
		errs = append(errs, fmt.Errorf("%s: %w", pkgSourceLabel(rawURL), err))
	}
	return "", errors.Join(errs...)
}

func (u *Updater) downloadPkgFrom(rawURL string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return "", fmt.Errorf("invalid pkg URL: %w", err)
	}
	log.Info("downloading pkg for update", "url", rawURL)
	resp, err := u.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("pkg download failed: %s", SafeDownloadErrorMessage(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("pkg download failed with status %d", resp.StatusCode)
	}

	f, err := os.CreateTemp("", "breeze-agent-*.pkg")
	if err != nil {
		return "", fmt.Errorf("failed to create temp pkg file: %w", err)
	}
	if _, err := netpolicy.CopyBounded(f, resp.Body, maxUpdateBinaryBytes); err != nil {
		f.Close()
		removeCleanup(f.Name())
		return "", fmt.Errorf("failed to write pkg file: %w", err)
	}
	if err := f.Close(); err != nil {
		removeCleanup(f.Name())
		return "", fmt.Errorf("failed to write pkg file: %w", err)
	}
	return f.Name(), nil
}

// pkgSourceLabel names a pkg source for error messages without its query.
func pkgSourceLabel(rawURL string) string {
	if i := strings.IndexByte(rawURL, '?'); i >= 0 {
		return rawURL[:i]
	}
	return rawURL
}
