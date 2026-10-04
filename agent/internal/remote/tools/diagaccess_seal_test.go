package tools

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
)

// openDiagResult is the test-side inverse (the API has its own copy).
func openDiagResult(priv *ecdh.PrivateKey, sealed *DiagSealedResult) ([]byte, error) {
	epk, err := base64.StdEncoding.DecodeString(sealed.EphemeralPublic)
	if err != nil {
		return nil, err
	}
	pub, err := ecdh.X25519().NewPublicKey(epk)
	if err != nil {
		return nil, err
	}
	shared, err := priv.ECDH(pub)
	if err != nil {
		return nil, err
	}
	salt := append(append([]byte{}, epk...), priv.PublicKey().Bytes()...)
	key, err := hkdf.Key(sha256.New, shared, salt, diagSealInfoPrefix+sealed.AuthorizationID, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce, err := base64.StdEncoding.DecodeString(sealed.Nonce)
	if err != nil {
		return nil, err
	}
	ct, err := base64.StdEncoding.DecodeString(sealed.Ciphertext)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ct, []byte(sealed.AuthorizationID))
}
