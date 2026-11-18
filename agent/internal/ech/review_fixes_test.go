package ech

import (
	"net"
	"sync/atomic"
	"testing"
	"time"
)

// A later signature in a streak classifies only crypto/tls's read-ahead; a
// fragment must not erase the richer evidence the drained first dial found.
func TestDial_FragmentDoesNotEraseRicherEvidence(t *testing.T) {
	var n atomic.Int32
	addr := startScriptedListener(t, func(c net.Conn) {
		if n.Add(1) == 1 {
			_, _ = c.Write([]byte(comcastShapedReply))
			_ = c.Close()
			return
		}
		_, _ = c.Write([]byte("HTTP/1.1 302"))
		_ = c.Close()
	})
	res, _ := noECHResolver(t)
	clock := &fakeClock{t: dialT0}
	d := newTestDialer(t, newRig(addr), res, clock)
	if _, err := dialTLS(t, d, baseCfg(nil), nil); !IsFilterSignature(err) {
		t.Fatalf("dial 1: %v", err)
	}
	clock.Set(dialT0.Add(5 * time.Second))
	if _, err := dialTLS(t, d, baseCfg(nil), nil); !IsFilterSignature(err) {
		t.Fatalf("dial 2: %v", err)
	}
	ev := d.Status(dialHost).Evidence
	if ev.Kind != BlockWebFilter || ev.LocationHost != "warn.filter-a.example" || !ev.SeenAt.Equal(dialT0.Add(5*time.Second)) {
		t.Fatalf("Evidence = %+v, want web_filter details kept and SeenAt advanced", ev)
	}
}

func TestHostState_NoteEvidenceRules(t *testing.T) {
	s := newHostState()
	rich := BlockEvidence{Kind: BlockWebFilter, HTTPStatus: 302, LocationHost: "warn.filter-a.example", SeenAt: dialT0}
	s.NoteEvidence(rich)
	s.NoteEvidence(BlockEvidence{Kind: BlockPlaintextUnknown, SeenAt: dialT0.Add(time.Second)})
	if s.lastEvidence.Kind != BlockWebFilter || !s.lastEvidence.SeenAt.Equal(dialT0.Add(time.Second)) {
		t.Fatalf("got %+v, want rich evidence kept with SeenAt advanced", s.lastEvidence)
	}
	// After a plain success the old evidence is stale: a fragment replaces it.
	s.NotePlainSuccessAt(dialT0.Add(2 * time.Second))
	s.NoteEvidence(BlockEvidence{Kind: BlockPlaintextUnknown, SeenAt: dialT0.Add(3 * time.Second)})
	if s.lastEvidence.Kind != BlockPlaintextUnknown {
		t.Fatalf("got %+v, want plaintext_unknown after a plain success", s.lastEvidence)
	}
	// A certificate failure always replaces.
	s.NoteEvidence(rich)
	cert := BlockEvidence{Kind: BlockUntrustedCertificate, SeenAt: dialT0.Add(4 * time.Second)}
	s.NoteEvidence(cert)
	if s.lastEvidence != cert {
		t.Fatalf("got %+v, want the certificate evidence", s.lastEvidence)
	}
}
