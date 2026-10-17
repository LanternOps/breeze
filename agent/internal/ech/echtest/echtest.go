// Package echtest is a test-only rig for proving that an HTTP client's TLS
// dials go through the shared ECH dialer. Only _test files import it, so it
// is never linked into an agent binary.
package echtest

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"math/big"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ech"
)

// PublicName is the outer (cleartext) SNI of the rig's ECH config.
const PublicName = "public.echtest.invalid"

// Rig is an HTTPS server that serves only ECH-accepted requests, plus a
// shared ECH dialer that already has the host in ECH mode.
type Rig struct {
	// Host is the inner server name the rig's certificate is valid for.
	Host string
	// Addr is the server's 127.0.0.1 listen address.
	Addr string
	// Pool trusts the server's self-signed certificate.
	Pool *x509.CertPool
	// Dialer is the installed shared ECH dialer.
	Dialer *ech.Dialer
}

// Start serves handler for host over TLS 1.3 with ECH keys. A request whose
// handshake did not accept ECH gets 421 and never reaches handler. It installs
// (and on cleanup restores) a shared ECH dialer that has host in ECH mode
// with the rig's config cached, and whose TCP leg goes to the rig unless the
// context carries one (ech.WithTCPDial). Build the client under test AFTER
// Start: transports bind the shared dialer when they are constructed.
func Start(t testing.TB, host string, handler http.Handler) *Rig {
	t.Helper()
	list, key := configList(t, PublicName)
	addr, pool := serve(t, []string{host, PublicName}, key, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || !r.TLS.ECHAccepted {
			http.Error(w, "ech required", http.StatusMisdirectedRequest)
			return
		}
		handler.ServeHTTP(w, r)
	}))

	cache := ech.NewCache("")
	cache.Put(host, ech.ECHConfig{ConfigList: list, TTL: 24 * time.Hour})
	d := ech.New(ech.Options{
		TCPDial: ech.TCPDialHonouringContext(func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, addr)
		}),
		// Never reached (the cached config is fresh); a dead endpoint keeps
		// a stray lookup off the real network.
		Resolver:      ech.NewResolver(nil, "http://127.0.0.1:1/dns-query"),
		Cache:         cache,
		LocalEnabled:  true,
		ServerEnabled: true,
	})
	d.ForceModeForTest(host, ech.ModeECH, time.Now())
	t.Cleanup(ech.SetSharedForTest(d))
	return &Rig{Host: host, Addr: addr, Pool: pool, Dialer: d}
}

// URL returns https://<host><path>.
func (r *Rig) URL(path string) string { return "https://" + r.Host + path }

// configList builds a draft-ietf-tls-esni-18 ECHConfigList (DHKEM(X25519,
// HKDF-SHA256), HKDF-SHA256, AES-128-GCM) and the matching server key.
func configList(t testing.TB, publicName string) ([]byte, tls.EncryptedClientHelloKey) {
	t.Helper()
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var cfg bytes.Buffer
	cfg.WriteByte(0)                    // config_id
	cfg.Write([]byte{0x00, 0x20})       // kem_id X25519
	cfg.Write([]byte{0x00, 0x20})       // public_key length
	cfg.Write(priv.PublicKey().Bytes()) // public_key
	cfg.Write([]byte{0x00, 0x04, 0x00, 0x01, 0x00, 0x01})
	cfg.WriteByte(64) // maximum_name_length
	cfg.WriteByte(uint8(len(publicName)))
	cfg.WriteString(publicName)
	cfg.Write([]byte{0x00, 0x00}) // extensions
	var one bytes.Buffer
	one.Write([]byte{0xfe, 0x0d})
	_ = binary.Write(&one, binary.BigEndian, uint16(cfg.Len()))
	one.Write(cfg.Bytes())
	var out bytes.Buffer
	_ = binary.Write(&out, binary.BigEndian, uint16(one.Len()))
	out.Write(one.Bytes())
	return out.Bytes(), tls.EncryptedClientHelloKey{Config: one.Bytes(), PrivateKey: priv.Bytes(), SendAsRetry: true}
}

func serve(t testing.TB, names []string, key tls.EncryptedClientHelloKey, handler http.Handler) (string, *x509.CertPool) {
	t.Helper()
	pk, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "echtest"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:              names,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &pk.PublicKey, pk)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: handler}
	go func() {
		_ = srv.Serve(tls.NewListener(ln, &tls.Config{
			Certificates:             []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: pk}},
			MinVersion:               tls.VersionTLS13,
			EncryptedClientHelloKeys: []tls.EncryptedClientHelloKey{key},
			NextProtos:               []string{"h2", "http/1.1"},
		}))
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if srv.Shutdown(ctx) != nil {
			_ = srv.Close()
		}
	})
	return ln.Addr().String(), pool
}
