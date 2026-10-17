package ech

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
	"errors"
	"math/big"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// newECHConfigList returns (configList bytes for the client, server key for
// tls.Config.EncryptedClientHelloKeys). Layout: draft-ietf-tls-esni-18 with
// DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM.
func newECHConfigList(t *testing.T, publicName string) ([]byte, tls.EncryptedClientHelloKey) {
	t.Helper()
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pub := priv.PublicKey().Bytes()
	var cfg bytes.Buffer
	cfg.WriteByte(0)
	cfg.Write([]byte{0x00, 0x20})
	cfg.Write([]byte{0x00, 0x20})
	cfg.Write(pub)
	cfg.Write([]byte{0x00, 0x04, 0x00, 0x01, 0x00, 0x01})
	cfg.WriteByte(64)
	cfg.WriteByte(uint8(len(publicName)))
	cfg.WriteString(publicName)
	cfg.Write([]byte{0x00, 0x00})
	var one bytes.Buffer
	one.Write([]byte{0xfe, 0x0d})
	_ = binary.Write(&one, binary.BigEndian, uint16(cfg.Len()))
	one.Write(cfg.Bytes())
	var list bytes.Buffer
	_ = binary.Write(&list, binary.BigEndian, uint16(one.Len()))
	list.Write(one.Bytes())
	return list.Bytes(), tls.EncryptedClientHelloKey{Config: one.Bytes(), PrivateKey: priv.Bytes(), SendAsRetry: true}
}

// startTLSServer serves handler on 127.0.0.1 with a self-signed cert for names;
// echKeys may be nil (plain-only server). h2 is negotiated via NextProtos.
func startTLSServer(t *testing.T, names []string, echKeys []tls.EncryptedClientHelloKey, handler http.Handler) (string, *x509.CertPool) {
	t.Helper()
	return startTLSServerWith(t, names, echKeys, handler, nil)
}

// startTLSServerWith is startTLSServer with a hook to adjust the server's
// tls.Config (e.g. MaxVersion) before it starts listening.
func startTLSServerWith(t *testing.T, names []string, echKeys []tls.EncryptedClientHelloKey, handler http.Handler, mutate func(*tls.Config)) (string, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "ech-test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     names,
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},

		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
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
	srvCfg := &tls.Config{
		Certificates:             []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
		MinVersion:               tls.VersionTLS13,
		EncryptedClientHelloKeys: echKeys,
		NextProtos:               []string{"h2", "http/1.1"},
	}
	if mutate != nil {
		mutate(srvCfg)
	}
	tlsLn := tls.NewListener(ln, srvCfg)
	srv := &http.Server{Handler: handler}
	go func() { _ = srv.Serve(tlsLn) }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if srv.Shutdown(ctx) != nil {
			_ = srv.Close()
		}
	})
	return ln.Addr().String(), pool
}

// startFilterListener answers every connection with a plaintext 302 (the
// filter signature) and records the count. It reads the start of the
// ClientHello before replying so close does not RST over unread data.
func startFilterListener(t *testing.T) (string, *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	hits := new(atomic.Int32)
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			hits.Add(1)
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
				buf := make([]byte, 4096)
				_, _ = c.Read(buf)
				_, _ = c.Write([]byte("HTTP/1.1 302 Found\r\nLocation: https://example.invalid/warn\r\nConnection: close\r\n\r\n"))
			}(c)
		}
	}()
	return ln.Addr().String(), hits
}

func TestECHTestServer_AcceptsECH(t *testing.T) {
	list, key := newECHConfigList(t, "public.test")
	addr, pool := startTLSServer(t, []string{"inner.test", "public.test"}, []tls.EncryptedClientHelloKey{key},
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", addr, &tls.Config{
		ServerName:                     "inner.test",
		RootCAs:                        pool,
		MinVersion:                     tls.VersionTLS13,
		EncryptedClientHelloConfigList: list,
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()
	if !conn.ConnectionState().ECHAccepted {
		t.Fatal("ECHAccepted = false, want true")
	}
}

func TestECHTestServer_PlainServerRejectsECH(t *testing.T) {
	list, _ := newECHConfigList(t, "public.test")
	addr, pool := startTLSServer(t, []string{"inner.test", "public.test"}, nil,
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", addr, &tls.Config{
		ServerName:                     "inner.test",
		RootCAs:                        pool,
		MinVersion:                     tls.VersionTLS13,
		EncryptedClientHelloConfigList: list,
	})
	if err == nil {
		_ = conn.Close()
		t.Fatal("expected ECH rejection error")
	}
	var echErr *tls.ECHRejectionError
	if !errors.As(err, &echErr) {
		t.Fatalf("err = %T %v, want *tls.ECHRejectionError", err, err)
	}
}
