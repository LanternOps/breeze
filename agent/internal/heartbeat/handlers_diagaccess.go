package heartbeat

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// diagnosticGrantEnv binds grant-mode file access to this device's identity
// and to the deployment keys pinned from THIS server's heartbeat. It
// deliberately does not use the updater's trust set, which also admits the
// embedded vendor release keys: a release-signing key has no business
// authorizing a read of a customer's files. A device with no pinned key
// cannot verify an authorization, so grant mode refuses.
func (h *Heartbeat) diagnosticGrantEnv() tools.DiagGrantEnv {
	env := tools.DiagGrantEnv{}
	if h == nil || h.config == nil {
		return env
	}
	env.DeviceID = h.config.DeviceID
	env.OrgID = h.config.OrgID
	pinned := h.pinnedManifestPubKeys()
	env.Verify = func(keyID string, payload, signature []byte) error {
		return verifyWithPinnedDeploymentKey(pinned, keyID, payload, signature)
	}
	return env
}

var errDiagKeyNotPinned = errors.New("signing key is not a pinned deployment key")

func verifyWithPinnedDeploymentKey(pinned []string, keyID string, payload, signature []byte) error {
	if !config.ValidManifestKeyID(keyID) {
		return errDiagKeyNotPinned
	}
	keys, err := config.ParsePinnedManifestKeys(pinned)
	if err != nil {
		return err
	}
	pubB64, ok := keys[keyID]
	if !ok {
		return errDiagKeyNotPinned
	}
	pub, err := base64.StdEncoding.DecodeString(pubB64)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return errDiagKeyNotPinned
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), payload, signature) {
		return errors.New("signature verification failed")
	}
	return nil
}
