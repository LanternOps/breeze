package tools

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
)

// Diagnostic results are sealed to a one-time X25519 key that the API process
// generated for this command and holds only in memory while it waits. The
// command row therefore stores ciphertext: file contents and listings never
// sit readable in device_commands.result, even if the API crashes before the
// tool consumes them. The public half is bound into the signed authorization,
// so the agent cannot be steered to seal for anyone else.
//
// Scheme (mirrored in apps/api/src/services/diagnosticAccess/seal.ts):
//   shared = X25519(agentEphemeral, serverPublic)
//   key    = HKDF-SHA256(shared, salt = agentEphemeralPub || serverPublic,
//                        info = "breeze-diag-result-v1|" + authorizationId, 32)
//   AES-256-GCM, 12-byte random nonce, AAD = authorizationId.

const diagSealInfoPrefix = "breeze-diag-result-v1|"

// DiagSealedResult is what reaches the command result's stdout.
type DiagSealedResult struct {
	Version         int    `json:"v"`
	AuthorizationID string `json:"authorizationId"`
	EphemeralPublic string `json:"epk"`
	Nonce           string `json:"nonce"`
	Ciphertext      string `json:"ct"`
}

func sealDiagResult(resultPublicKeyB64, authorizationID string, body any) (*DiagSealedResult, error) {
	raw, err := base64.StdEncoding.DecodeString(resultPublicKeyB64)
	if err != nil || len(raw) != 32 {
		return nil, diagErr(DiagErrEncryption, "result key is not a 32-byte X25519 public key")
	}
	curve := ecdh.X25519()
	serverPub, err := curve.NewPublicKey(raw)
	if err != nil {
		return nil, diagErr(DiagErrEncryption, "result key is not a valid X25519 public key")
	}
	eph, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, diagErr(DiagErrEncryption, "could not generate an ephemeral key")
	}
	shared, err := eph.ECDH(serverPub)
	if err != nil {
		return nil, diagErr(DiagErrEncryption, "key agreement failed")
	}
	salt := append(append([]byte{}, eph.PublicKey().Bytes()...), raw...)
	key, err := hkdf.Key(sha256.New, shared, salt, diagSealInfoPrefix+authorizationID, 32)
	if err != nil {
		return nil, diagErr(DiagErrEncryption, "key derivation failed")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, diagErr(DiagErrEncryption, "cipher setup failed")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, diagErr(DiagErrEncryption, "cipher setup failed")
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, diagErr(DiagErrEncryption, "could not generate a nonce")
	}
	plain, err := json.Marshal(body)
	if err != nil {
		return nil, diagErr(DiagErrEncryption, "could not encode the result")
	}
	ct := gcm.Seal(nil, nonce, plain, []byte(authorizationID))
	return &DiagSealedResult{
		Version:         1,
		AuthorizationID: authorizationID,
		EphemeralPublic: base64.StdEncoding.EncodeToString(eph.PublicKey().Bytes()),
		Nonce:           base64.StdEncoding.EncodeToString(nonce),
		Ciphertext:      base64.StdEncoding.EncodeToString(ct),
	}, nil
}
