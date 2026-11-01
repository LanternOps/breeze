package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

func writeProviderConfig(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "prov.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func s3ProviderConfigJSON(extra string) string {
	return `{"provider":"s3","providerConfig":{"bucket":"b","region":"us-east-1","accessKey":"k","secretKey":"s"` + extra + `}}`
}

// #9441: --key-prefix makes the --provider-config S3 provider read the
// snapshot's objects under <prefix>/snapshots/... instead of the bucket root.
func TestProviderFromConfigFile_AppliesKeyPrefix(t *testing.T) {
	path := writeProviderConfig(t, s3ProviderConfigJSON(""))
	var warn strings.Builder
	provider, err := providerFromConfigFile(path, "/msp/acme/", &warn)
	if err != nil {
		t.Fatal(err)
	}
	s3p, ok := provider.(*providers.S3Provider)
	if !ok {
		t.Fatalf("provider = %T, want *providers.S3Provider", provider)
	}
	if got := s3p.KeyPrefix(); got != "msp/acme" {
		t.Fatalf("KeyPrefix() = %q, want msp/acme", got)
	}
	if warn.Len() != 0 {
		t.Fatalf("unexpected warning: %s", warn.String())
	}
}

func TestProviderFromConfigFile_RefusesInvalidKeyPrefix(t *testing.T) {
	path := writeProviderConfig(t, s3ProviderConfigJSON(""))
	if _, err := providerFromConfigFile(path, "a/snapshots", &strings.Builder{}); err == nil || !strings.Contains(err.Error(), "--key-prefix") {
		t.Fatalf("err = %v, want a --key-prefix error", err)
	}
}

func TestProviderFromConfigFile_RefusesKeyPrefixForNonS3(t *testing.T) {
	path := writeProviderConfig(t, `{"provider":"local","providerConfig":{"path":"`+filepath.ToSlash(t.TempDir())+`"}}`)
	if _, err := providerFromConfigFile(path, "msp", &strings.Builder{}); err == nil || !strings.Contains(err.Error(), "only applies to an s3") {
		t.Fatalf("err = %v, want the s3-only error", err)
	}
	// No prefix: a local provider is fine.
	if _, err := providerFromConfigFile(path, "", &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
}

// The destination's providerConfig.prefix is NOT applied implicitly: it can
// differ from the snapshot's recorded key root (a prefix change, or a
// snapshot taken before prefixes were applied). The operator is told to pass
// --key-prefix instead.
func TestProviderFromConfigFile_DestinationPrefixWarnsAndIsNotApplied(t *testing.T) {
	path := writeProviderConfig(t, s3ProviderConfigJSON(`,"prefix":"msp/acme"`))
	var warn strings.Builder
	provider, err := providerFromConfigFile(path, "", &warn)
	if err != nil {
		t.Fatal(err)
	}
	if got := provider.(*providers.S3Provider).KeyPrefix(); got != "" {
		t.Fatalf("KeyPrefix() = %q, want none (not applied implicitly)", got)
	}
	if !strings.Contains(warn.String(), "--key-prefix") || !strings.Contains(warn.String(), "msp/acme") {
		t.Fatalf("warning = %q, want it to name the prefix and --key-prefix", warn.String())
	}
}

// The flag itself reaches providerFromConfigFile: an invalid --key-prefix
// fails through Execute (it would be silently ignored if unbound).
func TestRebuildCommand_KeyPrefixFlagReachesProviderConfig(t *testing.T) {
	dir := t.TempDir()
	path := writeProviderConfig(t, s3ProviderConfigJSON(""))
	cmd := newRebuildCommand()
	cmd.SetArgs([]string{
		"--snapshot", "s1", "--provider-config", path, "--key-prefix", "a/snapshots",
		"--target", "image:" + filepath.Join(dir, "t.img"), "--image-size", "1G", "--dry-run",
	})
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "--key-prefix") || !strings.Contains(err.Error(), "snapshots") {
		t.Fatalf("expected the --key-prefix reserved-segment error, got: %v", err)
	}
}

func TestRebuildCommand_KeyPrefixRefusedInTokenMode(t *testing.T) {
	dir := t.TempDir()
	cmd := newRebuildCommand()
	cmd.SetArgs([]string{
		"--token", "brz_rec_test", "--server", "http://example.invalid", "--key-prefix", "msp",
		"--target", "image:" + filepath.Join(dir, "t.img"), "--image-size", "1G",
	})
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "--key-prefix") {
		t.Fatalf("expected a --key-prefix/--token error, got: %v", err)
	}
}
