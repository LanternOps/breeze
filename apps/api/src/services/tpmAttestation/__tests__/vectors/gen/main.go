// Command gen writes the MakeCredential test vectors the API's TypeScript
// implementation (../../../makeCredential.ts) is checked against (#8318 T1, spec
// 2026-10-12 §12.2 review gate). go-tpm is the reference: it serializes both
// TPMT_PUBLIC areas, names the AK, and runs credactivation.Generate.
//
// The seed is fixed by replacing crypto/rand.Reader for the call, so the
// credential blob (KDFa, AES-CFB, HMAC) is byte-exact. RSA-OAEP may draw its
// own randomness, so the encrypted seed is checked by decrypting it with the
// EK private key, which the vectors carry (test keys only).
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"

	legacy "github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/legacy/tpm2/credactivation"
	"github.com/google/go-tpm/tpm2"
)

type vector struct {
	Name             string `json:"name"`
	EKPublic         string `json:"ekPublic"`
	EKPrivatePKCS8   string `json:"ekPrivatePkcs8"`
	EKSPKISHA256     string `json:"ekSpkiSha256"`
	AKPublic         string `json:"akPublic"`
	AKName           string `json:"akName"`
	Seed             string `json:"seed"`
	Secret           string `json:"secret"`
	CredentialBlob   string `json:"credentialBlob"`
	EncryptedSeed    string `json:"encryptedSeed"`
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// stripU16 removes one TPM2B size prefix, checking it matches.
func stripU16(b []byte) []byte {
	n := int(binary.BigEndian.Uint16(b))
	if n != len(b)-2 {
		panic(fmt.Sprintf("size prefix %d does not match %d bytes", n, len(b)-2))
	}
	return b[2:]
}

func ekPublic(key *rsa.PublicKey) tpm2.TPMTPublic {
	pub := tpm2.RSAEKTemplate
	pub.Unique = tpm2.NewTPMUPublicID(tpm2.TPMAlgRSA, &tpm2.TPM2BPublicKeyRSA{Buffer: key.N.Bytes()})
	return pub
}

func akPublic(key *rsa.PublicKey) tpm2.TPMTPublic {
	return tpm2.TPMTPublic{
		Type:    tpm2.TPMAlgRSA,
		NameAlg: tpm2.TPMAlgSHA256,
		ObjectAttributes: tpm2.TPMAObject{
			FixedTPM:            true,
			FixedParent:         true,
			SensitiveDataOrigin: true,
			UserWithAuth:        true,
			NoDA:                true,
			Restricted:          true,
			SignEncrypt:         true,
		},
		Parameters: tpm2.NewTPMUPublicParms(tpm2.TPMAlgRSA, &tpm2.TPMSRSAParms{
			Scheme: tpm2.TPMTRSAScheme{
				Scheme:  tpm2.TPMAlgRSASSA,
				Details: tpm2.NewTPMUAsymScheme(tpm2.TPMAlgRSASSA, &tpm2.TPMSSigSchemeRSASSA{HashAlg: tpm2.TPMAlgSHA256}),
			},
			KeyBits: 2048,
		}),
		Unique: tpm2.NewTPMUPublicID(tpm2.TPMAlgRSA, &tpm2.TPM2BPublicKeyRSA{Buffer: key.N.Bytes()}),
	}
}

func generate(name string, secretLen int) vector {
	ek := must(rsa.GenerateKey(rand.Reader, 2048))
	ak := must(rsa.GenerateKey(rand.Reader, 2048))
	ekPub := ekPublic(&ek.PublicKey)
	akPub := akPublic(&ak.PublicKey)
	akName := must(tpm2.ObjectName(&akPub))

	seed := make([]byte, 16) // the EK's AES-128: the seed is the symmetric key size
	must(io.ReadFull(rand.Reader, seed))
	secret := make([]byte, secretLen)
	must(io.ReadFull(rand.Reader, secret))

	digest := sha256.Sum256(tpm2.Marshal(akPub))
	aik := &legacy.HashValue{Alg: legacy.AlgSHA256, Value: digest[:]}
	if !bytes.Equal(must(aik.Encode()), akName.Buffer) {
		panic("legacy and tpm2 AK names differ")
	}

	real := rand.Reader
	rand.Reader = io.MultiReader(bytes.NewReader(seed), real)
	idObject, encSecret := func() ([]byte, []byte) {
		defer func() { rand.Reader = real }()
		id, enc, err := credactivation.Generate(aik, &ek.PublicKey, 16, secret)
		if err != nil {
			panic(err)
		}
		return id, enc
	}()

	// TPM2B_ID_OBJECT and TPM2B_ENCRYPTED_SECRET without their size prefix:
	// the buffers TPM2_ActivateCredential takes.
	blob := stripU16(idObject)
	encrypted := stripU16(encSecret)
	for len(encrypted) != 256 {
		encrypted = stripU16(encrypted)
	}
	check := must(rsa.DecryptOAEP(sha256.New(), nil, ek, encrypted, append([]byte("IDENTITY"), 0)))
	if !bytes.Equal(check, seed) {
		panic("the encrypted seed does not decrypt to the seed")
	}

	spki := must(x509.MarshalPKIXPublicKey(&ek.PublicKey))
	spkiHash := sha256.Sum256(spki)
	return vector{
		Name:           name,
		EKPublic:       b64(tpm2.Marshal(ekPub)),
		EKPrivatePKCS8: b64(must(x509.MarshalPKCS8PrivateKey(ek))),
		EKSPKISHA256:   fmt.Sprintf("%x", spkiHash),
		AKPublic:       b64(tpm2.Marshal(akPub)),
		AKName:         b64(akName.Buffer),
		Seed:           b64(seed),
		Secret:         b64(secret),
		CredentialBlob: b64(blob),
		EncryptedSeed:  b64(encrypted),
	}
}

func main() {
	out := map[string]any{
		"generator": "apps/api/src/services/tpmAttestation/__tests__/vectors/gen (go-tpm v0.9.8, legacy/tpm2/credactivation)",
		"vectors": []vector{
			generate("32-byte secret", 32),
			generate("16-byte secret", 16),
			generate("1-byte secret", 1),
		},
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}
