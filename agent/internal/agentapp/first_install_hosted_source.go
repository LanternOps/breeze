package agentapp

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// Hosted first-install staging (#5899).
//
// A hosted build cannot stage its watchdog (or macOS desktop helper) from the
// PUBLIC GitHub release. release.yml stamps every asset it publishes as
// edition "self-host" — hosted artifacts are built in a separate, private
// repository and deliberately never reach the public manifest — while
// firstInstallEditionAllowed requires edition "hosted" whenever
// hostpolicy.Enforced(). So `breeze-agent service install` on a hosted binary
// fetched the public manifest and then refused it, on every OS, every time:
//
//	verify and stage watchdog: release manifest asset policy does not
//	authorize breeze-watchdog-windows-amd64.exe
//
// The fix is to source the artifact where the hosted-edition manifest actually
// lives: the agent's own control plane. binarySync verifies the hosted signed
// manifest at boot and stores the exact bytes plus their Ed25519 signature on
// the agent_versions row, and the public
//
//	GET /api/v1/agent-versions/:version/download?platform=&arch=&component=
//
// endpoint hands them back verbatim alongside an absolute artifact URL. That is
// the same endpoint the updater has used since #646; this reuses it rather than
// inventing a second manifest channel.
//
// Nothing about the trust decision moves. The server is a DISTRIBUTION channel,
// never the trust root: the manifest is still verified against the build's
// embedded Ed25519 key, and the asset is still bound to the signed digest,
// size, release tag, edition and platformTrust by verifyFirstInstallManifest.
// Exactly one binding is relaxed, and only on this path — see serverSourced in
// firstInstallArtifactSpec.

// agentVersionDownloadInfo is the JSON body of
// GET /api/v1/agent-versions/:version/download. Field names match the updater's
// downloadInfo struct, which decodes the same response.
type agentVersionDownloadInfo struct {
	URL               string `json:"url"`
	Checksum          string `json:"checksum"`
	Manifest          string `json:"manifest"`
	ManifestSignature string `json:"manifestSignature"`
	SigningKeyID      string `json:"signingKeyId"`
}

// maxAgentVersionDownloadInfo bounds the JSON response. The manifest is the
// only large field and the server caps it at maxFirstInstallManifest; the
// slack covers base64 signature, URLs and JSON framing.
const maxAgentVersionDownloadInfo = maxFirstInstallManifest + 64*1024

// resolveFirstInstallServerURL returns the origin of the control plane a hosted
// build may stage first-install artifacts from.
//
// configured is the persisted server URL (config.Config.ServerURL). It is empty
// on a genuinely fresh host, because `service install` runs BEFORE `enroll` in
// every install lane. A hosted build still knows where it belongs in that case:
// hostpolicy's compile-time allowlist is injected by the hosted release
// pipeline and names the control planes this binary is allowed to talk to. When
// it names exactly one host, that host is the answer; when it names several
// there is no way to choose, and guessing would silently enroll the watchdog
// lookup against the wrong region — so that is an error with a concrete
// remediation instead.
func resolveFirstInstallServerURL(configured string) (string, error) {
	if !hostpolicy.Enforced() {
		return "", fmt.Errorf("control-plane first-install staging is hosted-only")
	}
	if configured = strings.TrimSpace(configured); configured != "" {
		parsed, err := url.Parse(configured)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
			// Deliberately does not echo the raw value: it comes from a config
			// file and this error is printed verbatim to the operator.
			return "", fmt.Errorf("configured server URL is not a usable http(s) URL")
		}
		if err := hostpolicy.AllowedURL(configured); err != nil {
			return "", err
		}
		return strings.TrimSuffix(parsed.Scheme+"://"+parsed.Host, "/"), nil
	}
	hosts := hostpolicy.Hosts()
	if len(hosts) != 1 {
		return "", fmt.Errorf(
			"this host is not enrolled yet and the build allows %d control planes (%s); "+
				"run `breeze-agent enroll` first, then re-run `service install`",
			len(hosts), strings.Join(hosts, ", "))
	}
	return "https://" + hosts[0], nil
}

// persistedServerURLForInstall reads the enrolled control-plane URL out of
// agent.yaml for the `service install` command paths. It uses
// config.PersistedServerURL rather than config.Load because that helper reads
// only agent.yaml and never touches the root-only secrets.yaml.
//
// "No URL" degrades to "" so a single-control-plane hosted build can fall back
// to its own allowlist — but only TWO causes are allowed to do so silently: the
// file does not exist, and the file exists without a server_url. Both are the
// normal shape of a host that has not run `enroll` yet, and `service install`
// runs before `enroll` in every install lane.
//
// Every other cause — unreadable file, corrupt YAML, a torn/malformed
// server_url (config.SetAllAndPersist truncates in place, so a concurrent read
// really can observe one) — means this host probably IS enrolled and its config
// is broken. Returning a bare "" there made the fallback either guess a control
// plane and carry on as if nothing happened, or tell the operator "this host is
// not enrolled yet" — advice that is simply false and sends them to re-enroll
// instead of to the config file. So those warn on stderr, which is where every
// other diagnostic in the service-install command family goes.
func persistedServerURLForInstall() string {
	serverURL, err := config.PersistedServerURL(cfgFile)
	switch {
	case err == nil:
		return serverURL
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, config.ErrNoPersistedServerURL):
		// Genuinely fresh host: expected, silent.
		return ""
	default:
		fmt.Fprintf(os.Stderr,
			"Warning: could not read the persisted server URL (%v).\n"+
				"Falling back to this build's control-plane allowlist. If this host IS\n"+
				"enrolled, fix the agent config — the fallback can otherwise report it as\n"+
				"un-enrolled or resolve the wrong control plane.\n", err)
		return ""
	}
}

// fetchFirstInstallServerArtifact asks the control plane for the signed release
// manifest covering component/version/goos/goarch, plus the URL to fetch the
// artifact itself from.
//
// It performs NO trust decision beyond pinning the signing key ID: the returned
// bytes go straight into verifyFirstInstallManifest, which is where the
// signature and the asset policy are checked.
func fetchFirstInstallServerArtifact(
	client *http.Client, serverURL, component, version, goos, goarch string,
) (manifest, signature []byte, assetURL string, err error) {
	if !firstInstallVersionPattern.MatchString(version) {
		return nil, nil, "", fmt.Errorf("release version is malformed")
	}
	infoURL := fmt.Sprintf("%s/api/v1/agent-versions/%s/download?platform=%s&arch=%s&component=%s",
		serverURL, url.PathEscape(version), url.QueryEscape(goos), url.QueryEscape(goarch),
		url.QueryEscape(component))

	body, err := fetchFirstInstallBytes(client, infoURL, "control-plane release metadata", maxAgentVersionDownloadInfo)
	if err != nil {
		return nil, nil, "", err
	}
	var info agentVersionDownloadInfo
	if err := json.Unmarshal(body, &info); err != nil {
		return nil, nil, "", fmt.Errorf("control-plane release metadata is invalid JSON: %w", err)
	}
	if info.Manifest == "" || info.ManifestSignature == "" {
		return nil, nil, "", fmt.Errorf(
			"control plane served no signed release manifest for %s %s/%s at version %s",
			component, goos, goarch, version)
	}
	// The manifest must be the OFFICIAL release-artifact manifest, signed by the
	// release key this binary embeds. A self-host deployment's per-deployment
	// `deploy-*` key is a legitimate update trust root (see the updater's
	// RequireManifestSigningKeyID) but is not one a hosted first install accepts:
	// staging a watchdog is a privileged, pre-enrollment action, so the only
	// acceptable signer is the release pipeline itself. An empty value is
	// refused too — first install has no legacy control planes to tolerate.
	if info.SigningKeyID != firstInstallManifestKeyID {
		return nil, nil, "", fmt.Errorf(
			"control-plane release manifest is signed by %q, not the official release key",
			info.SigningKeyID)
	}
	if strings.TrimSpace(info.URL) == "" {
		return nil, nil, "", fmt.Errorf("control-plane release metadata has no artifact URL")
	}
	return []byte(info.Manifest), []byte(info.ManifestSignature), info.URL, nil
}

// applyHostedFirstInstallSource rewrites spec to stage from the enrolled
// control plane instead of the public GitHub release.
//
// It is a no-op for self-host builds (the GitHub release carries exactly the
// self-host-edition assets they require) and for a spec that already carries
// explicit manifest URLs, which is the test seam.
//
// When the agent found a local sibling binary, spec.sourcePath stays and only
// the manifest moves: the sibling's bytes are then checked against the hosted
// manifest's digest, which is stricter than the old behaviour, not looser.
func applyHostedFirstInstallSource(spec *firstInstallArtifactSpec) error {
	if !hostpolicy.Enforced() || spec.manifestURL != "" || spec.signatureURL != "" {
		return nil
	}
	base, err := resolveFirstInstallServerURL(spec.serverURL)
	if err != nil {
		return err
	}
	client := spec.client
	if client == nil {
		// Production path: the control plane must be reached over HTTPS. A test
		// supplies its own client (and its own http:// httptest origin), the
		// same seam stageFirstInstallArtifact already uses for URL validation.
		if !strings.HasPrefix(base, "https://") {
			return fmt.Errorf("hosted control-plane staging requires an https server URL")
		}
		client = firstInstallHTTPClient()
	}
	manifest, signature, assetURL, err := fetchFirstInstallServerArtifact(
		client, base, spec.component, spec.version, spec.goos, spec.goarch)
	if err != nil {
		return err
	}
	spec.manifestBytes = manifest
	spec.signatureBytes = signature
	spec.serverSourced = true
	if spec.sourcePath == "" {
		spec.assetURL = assetURL
	}
	return nil
}
