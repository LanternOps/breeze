package ech

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

const comcastShapedReply = "HTTP/1.1 302 Found\r\nLocation: https://warn.filter-a.example/warn.html?url=http://cp.example/&token=abc\r\nConnection: close\r\n\r\n"

// startScriptedListener answers every connection by reading the start of the
// ClientHello, then running script on the conn. Open conns are closed at
// cleanup so a script that never finishes does not leak.
func startScriptedListener(t *testing.T, script func(c net.Conn)) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var (
		mu    sync.Mutex
		conns []net.Conn
	)
	t.Cleanup(func() {
		_ = ln.Close()
		mu.Lock()
		for _, c := range conns {
			_ = c.Close()
		}
		mu.Unlock()
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
			go func(c net.Conn) {
				_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
				buf := make([]byte, 4096)
				_, _ = c.Read(buf)
				_ = c.SetReadDeadline(time.Time{})
				script(c)
			}(c)
		}
	}()
	return ln.Addr().String()
}

func writeAndClose(reply string) func(net.Conn) {
	return func(c net.Conn) {
		_, _ = c.Write([]byte(reply))
		_ = c.Close()
	}
}

// drip writes the start of a status line and then nothing.
func drip(c net.Conn) { _, _ = c.Write([]byte("HTTP/1.1 302")) }

func TestDial_Filter302RecordsEvidence(t *testing.T) {
	addr := startScriptedListener(t, writeAndClose(comcastShapedReply))
	res, _ := noECHResolver(t)
	d := newTestDialer(t, newRig(addr), res, &fakeClock{t: dialT0})
	_, err := dialTLS(t, d, baseCfg(nil), nil)
	if !IsFilterSignature(err) {
		t.Fatalf("err = %v, want filter signature", err)
	}
	got := d.Status(dialHost).Evidence
	want := BlockEvidence{Kind: BlockWebFilter, HTTPStatus: 302, LocationHost: "warn.filter-a.example", SeenAt: dialT0}
	if got != want {
		t.Fatalf("Evidence = %+v, want %+v", got, want)
	}
}

func TestDial_FilterSplitReplyStillParsed(t *testing.T) {
	addr := startScriptedListener(t, func(c net.Conn) {
		_, _ = c.Write([]byte("HTTP/1.1 302 Found\r\n"))
		time.Sleep(50 * time.Millisecond)
		_, _ = c.Write([]byte("Location: https://warn.filter-a.example/warn?token=abc\r\n\r\n"))
		_ = c.Close()
	})
	res, _ := noECHResolver(t)
	d := newTestDialer(t, newRig(addr), res, &fakeClock{t: dialT0})
	if _, err := dialTLS(t, d, baseCfg(nil), nil); !IsFilterSignature(err) {
		t.Fatalf("err = %v, want filter signature", err)
	}
	if ev := d.Status(dialHost).Evidence; ev.Kind != BlockWebFilter || ev.LocationHost != "warn.filter-a.example" {
		t.Fatalf("Evidence = %+v, want web_filter warn.filter-a.example", ev)
	}
}

func TestDial_FilterDripDrainIsBounded(t *testing.T) {
	addr := startScriptedListener(t, drip)
	res, _ := noECHResolver(t)

	d := newTestDialer(t, newRig(addr), res, &fakeClock{t: dialT0})
	start := time.Now()
	if _, err := dialTLS(t, d, baseCfg(nil), nil); !IsFilterSignature(err) {
		t.Fatalf("err = %v, want filter signature", err)
	}
	if el := time.Since(start); el > 2500*time.Millisecond {
		t.Fatalf("dial took %v, want < 2.5s (drain budget 1s)", el)
	}
	if ev := d.Status(dialHost).Evidence; ev.Kind != BlockPlaintextUnknown || ev.HTTPStatus != 0 {
		t.Fatalf("Evidence = %+v, want plaintext_unknown", ev)
	}

	d2 := newTestDialer(t, newRig(addr), res, &fakeClock{t: dialT0})
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()
	start = time.Now()
	_, err := dialTLSCtx(t, ctx, d2, baseCfg(nil), nil)
	if err == nil {
		t.Fatal("dial succeeded, want an error")
	}
	if el := time.Since(start); el > 800*time.Millisecond {
		t.Fatalf("dial under a 200ms deadline took %v, want < 800ms (well under the 1s drain budget)", el)
	}
}

func TestDial_SecondSignatureInStreakDoesNotDrain(t *testing.T) {
	addr := startScriptedListener(t, drip)
	res, _ := noECHResolver(t)
	d := newTestDialer(t, newRig(addr), res, &fakeClock{t: dialT0})

	start := time.Now()
	if _, err := dialTLS(t, d, baseCfg(nil), nil); !IsFilterSignature(err) {
		t.Fatalf("dial 1: err = %v", err)
	}
	if el := time.Since(start); el < 900*time.Millisecond {
		t.Fatalf("first dial took %v, want >= 900ms (it drains)", el)
	}
	start = time.Now()
	if _, err := dialTLS(t, d, baseCfg(nil), nil); !IsFilterSignature(err) {
		t.Fatalf("dial 2: err = %v", err)
	}
	if el := time.Since(start); el > 500*time.Millisecond {
		t.Fatalf("second dial in the streak took %v, want < 500ms (no 1s drain)", el)
	}
	if ev := d.Status(dialHost).Evidence; ev.Kind != BlockPlaintextUnknown {
		t.Fatalf("Evidence = %+v, want plaintext_unknown kept on a latched streak", ev)
	}
}

func TestDial_LatchedStreakStillClassifiesFromReadAhead(t *testing.T) {
	addr := startScriptedListener(t, writeAndClose(comcastShapedReply))
	res, _ := noECHResolver(t)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, newRig(addr), res, clock)
	for i := 0; i < 2; i++ {
		clock.Set(dialT0.Add(time.Duration(i) * time.Second))
		if _, err := dialTLS(t, d, baseCfg(nil), nil); !IsFilterSignature(err) {
			t.Fatalf("dial %d: err = %v", i, err)
		}
	}
	ev := d.Status(dialHost).Evidence
	if ev.Kind != BlockWebFilter || !ev.SeenAt.Equal(dialT0.Add(time.Second)) {
		t.Fatalf("Evidence = %+v, want web_filter refreshed by the second dial", ev)
	}
}

func TestDial_FilterWarnHasNoPath(t *testing.T) {
	logs := captureLogs(t)
	addr := startScriptedListener(t, writeAndClose(comcastShapedReply))
	res, _ := noECHResolver(t)
	d := newTestDialer(t, newRig(addr), res, &fakeClock{t: dialT0})
	if _, err := dialTLS(t, d, baseCfg(nil), nil); !IsFilterSignature(err) {
		t.Fatalf("err = %v", err)
	}
	warns := logs.lines("level=WARN", "control plane answered the TLS handshake with plaintext HTTP")
	if len(warns) != 1 {
		t.Fatalf("filter warnings = %d, want 1; logs:\n%s", len(warns), logs)
	}
	for _, want := range []string{"kind=web_filter", "http_status=302", "location_host=warn.filter-a.example", "host=" + dialHost} {
		if !strings.Contains(warns[0], want) {
			t.Errorf("warning %q missing %q", warns[0], want)
		}
	}
	all := logs.String()
	for _, secret := range []string{"token", "/warn", "abc", "cp.example/"} {
		if strings.Contains(all, secret) {
			t.Errorf("logs leak %q:\n%s", secret, all)
		}
	}
}

func TestDial_UntrustedCertRecordsEvidenceNoECH(t *testing.T) {
	logs := captureLogs(t)
	addr, _ := startTLSServer(t, []string{dialHost}, nil, okHandler())
	res, _ := failResolver(t)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, newRig(addr), res, clock)
	// An empty pool, not nil: the device does not trust the server's CA, and
	// verification stays in Go rather than the platform verifier.
	base := baseCfg(x509.NewCertPool())
	for i := 0; i < 3; i++ {
		clock.Set(dialT0.Add(time.Duration(i) * 31 * time.Second))
		_, err := dialTLS(t, d, base, nil)
		if err == nil {
			t.Fatalf("dial %d succeeded against an untrusted certificate", i)
		}
		if IsFilterSignature(err) {
			t.Fatalf("dial %d: untrusted certificate read as a filter signature", i)
		}
	}
	st := d.Status(dialHost)
	if st.Mode != ModePlain {
		t.Fatalf("mode = %v, want plain (an untrusted certificate never engages ECH)", st.Mode)
	}
	if !st.FilterSignatureSeenAt.IsZero() {
		t.Fatal("FilterSignatureSeenAt set by a certificate failure")
	}
	want := BlockEvidence{Kind: BlockUntrustedCertificate, CertIssuer: "ech-test", SeenAt: dialT0.Add(62 * time.Second)}
	if st.Evidence != want {
		t.Fatalf("Evidence = %+v, want %+v", st.Evidence, want)
	}
	warns := logs.lines("level=WARN", "kind=untrusted_certificate")
	if len(warns) != 1 {
		t.Fatalf("certificate warnings = %d, want 1; logs:\n%s", len(warns), logs)
	}
	if !strings.Contains(warns[0], "cert_issuer=ech-test") {
		t.Errorf("warning %q missing cert_issuer", warns[0])
	}
}

func TestDial_UntrustedCertWarnRearmsAfterPlainSuccess(t *testing.T) {
	logs := captureLogs(t)
	addr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	res, _ := failResolver(t)
	d := newTestDialer(t, newRig(addr), res, &fakeClock{t: dialT0})
	untrusted := baseCfg(x509.NewCertPool())
	if _, err := dialTLS(t, d, untrusted, nil); err == nil {
		t.Fatal("untrusted dial succeeded")
	}
	mustDial(t, d, baseCfg(pool))
	if _, err := dialTLS(t, d, untrusted, nil); err == nil {
		t.Fatal("untrusted dial succeeded")
	}
	if n := len(logs.lines("level=WARN", "kind=untrusted_certificate")); n != 2 {
		t.Fatalf("certificate warnings = %d, want 2 (latch cleared by the plain success)", n)
	}
}

func TestDial_TrustedServerNoEvidence(t *testing.T) {
	addr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	res, _ := failResolver(t)
	d := newTestDialer(t, newRig(addr), res, &fakeClock{t: dialT0})
	tc := mustDial(t, d, baseCfg(pool))
	if ev := d.Status(dialHost).Evidence; !ev.IsZero() {
		t.Fatalf("Evidence = %+v, want none", ev)
	}
	cc, ok := tc.NetConn().(*captureConn)
	if !ok {
		t.Fatalf("plain attempt NetConn is %T, want *captureConn", tc.NetConn())
	}
	if c := cc.Captured(); len(c) != 0 {
		t.Fatalf("Captured() = %q on a healthy TLS connection", c)
	}
}

func TestDial_ClientCertAlertNoEvidence(t *testing.T) {
	addr, pool := startTLSServerWith(t, []string{dialHost}, nil, okHandler(), func(c *tls.Config) {
		c.MinVersion = tls.VersionTLS12
		c.MaxVersion = tls.VersionTLS12
		c.ClientAuth = tls.RequireAnyClientCert
	})
	res, _ := failResolver(t)
	d := newTestDialer(t, newRig(addr), res, &fakeClock{t: dialT0})
	if _, err := dialTLS(t, d, baseCfg(pool), nil); err == nil {
		t.Fatal("dial without a client certificate succeeded; the test is vacuous")
	}
	if ev := d.Status(dialHost).Evidence; !ev.IsZero() {
		t.Fatalf("Evidence = %+v, want none for a TLS alert", ev)
	}
}

func TestDial_PlainSuccessKeepsEvidenceForHealth(t *testing.T) {
	// Evidence is history, not state: the heartbeat compares its SeenAt with
	// LastPlainSuccessAt. A plain success must not erase it.
	filter := startScriptedListener(t, writeAndClose(comcastShapedReply))
	addr, pool := startTLSServer(t, []string{dialHost}, nil, okHandler())
	rig := newRig(filter)
	res, _ := noECHResolver(t)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, rig, res, clock)
	if _, err := dialTLS(t, d, baseCfg(pool), nil); !IsFilterSignature(err) {
		t.Fatalf("err = %v", err)
	}
	clock.Set(dialT0.Add(time.Minute))
	rig.setTarget(addr)
	mustDial(t, d, baseCfg(pool))
	st := d.Status(dialHost)
	if st.Evidence.Kind != BlockWebFilter || !st.LastPlainSuccessAt.After(st.Evidence.SeenAt) {
		t.Fatalf("status = %+v, want evidence kept and older than the plain success", st)
	}
}
