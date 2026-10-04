package heartbeat

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// A read-only diagnostic authorization must never ride along on any command
// other than the two diagnostic reads: dispatch refuses it before the handler
// runs, whatever else the payload says.
func TestDispatchRefusesDiagnosticAuthorizationOnOtherCommands(t *testing.T) {
	h := &Heartbeat{config: &config.Config{DeviceID: "dev-1"}}
	for _, typ := range []string{
		tools.CmdFileWrite, tools.CmdFileDelete, tools.CmdFileMkdir, tools.CmdFileRename,
		tools.CmdFileCopy, tools.CmdFileList, tools.CmdFileRead, tools.CmdRegistrySet,
		tools.CmdScript, tools.CmdKillProcess,
	} {
		res, ok := h.dispatchCommand(Command{
			ID:   "c1",
			Type: typ,
			Payload: map[string]any{
				"path":                                  "/tmp/x",
				"content":                               "pwned",
				tools.DiagnosticAuthorizationPayloadKey: map[string]any{"v": 1},
			},
		})
		if !ok {
			t.Fatalf("%s: no handler", typ)
		}
		if res.Status != "failed" || !strings.HasPrefix(res.Error, tools.DiagErrWriteNotPermitted) {
			t.Fatalf("%s carried a diagnostic authorization and was not refused: %+v", typ, res)
		}
	}
}

// The diagnostic commands demand an authorization; without one nothing is read.
func TestDiagnosticCommandsRequireAuthorization(t *testing.T) {
	h := &Heartbeat{config: &config.Config{DeviceID: "dev-1"}}
	for _, typ := range []string{tools.CmdDiagFileList, tools.CmdDiagFileRead} {
		res, ok := h.dispatchCommand(Command{ID: "c2", Type: typ, Payload: map[string]any{"path": "/etc/hosts"}})
		if !ok || res.Status != "failed" || !strings.HasPrefix(res.Error, tools.DiagErrMalformed) {
			t.Fatalf("%s ran without an authorization: %+v", typ, res)
		}
	}
}

func TestVerifyWithPinnedDeploymentKeyOnly(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	msg := []byte("breeze-agent-diagnostic-read-v1\nx")
	sig := ed25519.Sign(priv, msg)
	pinned := []string{"deploy-2026-09-28-abcd:" + base64.StdEncoding.EncodeToString(pub)}
	if err := verifyWithPinnedDeploymentKey(pinned, "deploy-2026-09-28-abcd", msg, sig); err != nil {
		t.Fatalf("pinned key rejected: %v", err)
	}
	if err := verifyWithPinnedDeploymentKey(pinned, "vendor-release-key", msg, sig); err == nil {
		t.Fatal("unpinned key id accepted")
	}
	if err := verifyWithPinnedDeploymentKey(nil, "deploy-2026-09-28-abcd", msg, sig); err == nil {
		t.Fatal("verified with no pinned keys")
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	_ = other
	if err := verifyWithPinnedDeploymentKey(pinned, "deploy-2026-09-28-abcd", append(msg, 'y'), sig); err == nil {
		t.Fatal("tampered message verified")
	}
}
