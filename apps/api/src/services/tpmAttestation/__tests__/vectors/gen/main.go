// Command gen writes the MakeCredential test vectors the API's TypeScript
// implementation (../../../makeCredential.ts) is checked against (#8318 T1, spec
// 2026-10-12 §12.2 review gate). go-tpm is the reference: it serializes both
// TPMT_PUBLIC areas, names the AK, and runs tpm2.CreateCredential, which
// sizes the seed to the EK's OAEP digest (32 bytes for SHA-256, Part 1 rev
// 1.83 B.10.3) and derives the EK's AES-128 key from it.
//
// The seed is fixed by feeding it first to the random reader CreateCredential
// takes, so the credential blob (KDFa, AES-CFB, HMAC) is byte-exact. RSA-OAEP may draw its
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

	seed := make([]byte, sha256.Size) // the EK's OAEP digest size
	must(io.ReadFull(rand.Reader, seed))
	secret := make([]byte, secretLen)
	must(io.ReadFull(rand.Reader, secret))

	ekKey := must(tpm2.ImportEncapsulationKey(&ekPub))
	// CreateCredential reads the seed first, then OAEP's own randomness.
	// It returns the buffers TPM2_ActivateCredential takes, with no outer
	// TPM2B size prefix.
	blob, encrypted, err := tpm2.CreateCredential(io.MultiReader(bytes.NewReader(seed), rand.Reader), ekKey, akName.Buffer, secret)
	if err != nil {
		panic(err)
	}
	if len(encrypted) != 256 {
		panic(fmt.Sprintf("the encrypted seed is %d bytes, not 256", len(encrypted)))
	}
	if n := int(binary.BigEndian.Uint16(blob)); n != sha256.Size {
		panic(fmt.Sprintf("the integrity HMAC is %d bytes, not 32", n))
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
		"generator": "apps/api/src/services/tpmAttestation/__tests__/vectors/gen (go-tpm v0.9.8, tpm2.CreateCredential)",
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
