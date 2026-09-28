package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/gosnmp/gosnmp"
)

type fakeResp struct {
	pdus []gosnmp.SnmpPDU
	err  error
}

// fakeWalker serves canned walks and records every requested OID. No sockets.
type fakeWalker struct {
	mu     sync.Mutex
	resp   map[string]fakeResp
	calls  []string
	bounds map[string]int
	block  bool // block until ctx is done
	closed bool
}

func (f *fakeWalker) Walk(ctx context.Context, oid string) ([]gosnmp.SnmpPDU, error) {
	f.mu.Lock()
	f.calls = append(f.calls, oid)
	r, block := f.resp[oid], f.block
	f.mu.Unlock()
	if block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return r.pdus, r.err
}

func (f *fakeWalker) WalkBounded(ctx context.Context, oid string, maxRows int) ([]gosnmp.SnmpPDU, bool, error) {
	f.mu.Lock()
	if f.bounds == nil {
		f.bounds = map[string]int{}
	}
	f.bounds[oid] = maxRows
	f.mu.Unlock()
	pdus, err := f.Walk(ctx, oid)
	if err == nil && len(pdus) > maxRows {
		return pdus[:maxRows], true, nil
	}
	return pdus, false, err
}

func (f *fakeWalker) Close() { f.mu.Lock(); f.closed = true; f.mu.Unlock() }

func (f *fakeWalker) walked(oid string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == oid {
			return true
		}
	}
	return false
}

func switchWalker() *fakeWalker {
	return &fakeWalker{resp: map[string]fakeResp{
		snmppoll.IfNameOID:               {pdus: []gosnmp.SnmpPDU{octets(snmppoll.IfNameOID+".101", []byte("ge-0/0/7")), octets(snmppoll.IfNameOID+".102", []byte("ge-0/0/8"))}},
		snmppoll.IfPhysAddressOID:        {pdus: []gosnmp.SnmpPDU{octets(snmppoll.IfPhysAddressOID+".101", []byte{2, 0, 0, 0, 1, 7})}},
		snmppoll.Dot1dBasePortIfIndexOID: {pdus: []gosnmp.SnmpPDU{integer(snmppoll.Dot1dBasePortIfIndexOID+".7", 101), integer(snmppoll.Dot1dBasePortIfIndexOID+".8", 102)}},
		// LLDP is running (local port table populated) but has no neighbours.
		snmppoll.LldpLocPortIDSubtypeOID: {pdus: []gosnmp.SnmpPDU{integer(snmppoll.LldpLocPortIDSubtypeOID+".7", 5)}},
		snmppoll.LldpLocPortIDOID:        {pdus: []gosnmp.SnmpPDU{octets(snmppoll.LldpLocPortIDOID+".7", []byte("ge-0/0/7"))}},
		snmppoll.CdpCacheDeviceIDOID:     {err: errors.New("request timeout (after 1 retries)")},
		snmppoll.Dot1dTpFdbPortOID: {pdus: []gosnmp.SnmpPDU{
			integer(snmppoll.Dot1dTpFdbPortOID+".2.0.0.0.0.16", 7),
			integer(snmppoll.Dot1dTpFdbPortOID+".2.0.0.0.0.17", 8),
		}},
	}}
}

var allProtocols = []string{SectionLLDP, SectionCDP, SectionFDB, SectionInterfaces}

func sectionsByKind(t *testing.T, sections []PhysicalSection) map[string]PhysicalSection {
	t.Helper()
	out := map[string]PhysicalSection{}
	for _, s := range sections {
		if _, dup := out[s.Kind]; dup {
			t.Fatalf("duplicate %s section", s.Kind)
		}
		out[s.Kind] = s
	}
	return out
}

func TestCollectPhysicalIndependentOutcomes(t *testing.T) {
	w := switchWalker()
	got := sectionsByKind(t, CollectPhysicalSections(context.Background(), w, PhysicalRequest{Target: "192.0.2.10", ContextKey: "default", Protocols: allProtocols}))
	if len(got) != 4 {
		t.Fatalf("every requested protocol needs an outcome: %#v", got)
	}
	if s := got[SectionLLDP]; s.Outcome != OutcomeComplete || s.RowCount != 0 || s.Lldp == nil {
		t.Fatalf("LLDP running with no neighbours is complete-empty: %#v", s)
	}
	if s := got[SectionCDP]; s.Outcome != OutcomeFailed || s.ReasonCode != "timeout" {
		t.Fatalf("CDP timeout is failed/timeout, never unsupported: %#v", s)
	}
	if !w.walked(snmppoll.Dot1dTpFdbPortOID) {
		t.Fatal("FDB must be attempted even when LLDP is empty and CDP failed")
	}
	fdb := got[SectionFDB]
	if len(fdb.Fdb) != 2 || fdb.RowCount != 2 || fdb.Fdb[0].IfIndex == nil || *fdb.Fdb[0].IfIndex != 101 {
		t.Fatalf("FDB positives lost: %#v", fdb)
	}
	if s := got[SectionInterfaces]; s.Outcome != OutcomeComplete || len(s.Interfaces) != 2 {
		t.Fatalf("interfaces: %#v", s)
	}
	for _, row := range got[SectionInterfaces].Interfaces {
		if row.IfIndex == 101 && (row.LldpLocalPort == nil || *row.LldpLocalPort != 7) {
			t.Fatalf("LLDP local port 7 resolved by interfaceName subtype: %#v", row)
		}
	}
	for _, s := range got {
		if s.ContextKey != "default" {
			t.Fatalf("context: %#v", s)
		}
	}
}

func TestCollectPhysicalOnlyRequestedProtocols(t *testing.T) {
	w := switchWalker()
	got := CollectPhysicalSections(context.Background(), w, PhysicalRequest{Target: "192.0.2.10", ContextKey: "default", Protocols: []string{SectionFDB}})
	if len(got) != 1 || got[0].Kind != SectionFDB {
		t.Fatalf("unrequested protocols must not emit sections: %#v", got)
	}
	if w.walked(snmppoll.LldpRemChassisIDOID) || w.walked(snmppoll.CdpCacheDeviceIDOID) {
		t.Fatal("unrequested protocols must not be walked")
	}
}

func TestCollectPhysicalOutcomeClassification(t *testing.T) {
	noSuch := []gosnmp.SnmpPDU{{Name: "." + snmppoll.LldpRemChassisIDOID, Type: gosnmp.NoSuchObject}}
	tests := []struct {
		name        string
		resp        map[string]fakeResp
		wantOutcome Outcome
		wantReason  string
		wantRows    int
	}{
		{"noSuchObject is unsupported", map[string]fakeResp{snmppoll.LldpRemChassisIDOID: {pdus: noSuch}}, OutcomeUnsupported, "not_supported", 0},
		{"absent MIB is unsupported", map[string]fakeResp{}, OutcomeUnsupported, "not_supported", 0},
		{"timeout is failed", map[string]fakeResp{snmppoll.LldpRemChassisIDOID: {err: context.DeadlineExceeded}}, OutcomeFailed, "timeout", 0},
		{"access denied is failed", map[string]fakeResp{snmppoll.LldpRemChassisIDOID: {err: &snmppoll.SnmpStatusError{Status: gosnmp.NoAccess}}}, OutcomeFailed, "access_denied", 0},
		{"authorization error is failed", map[string]fakeResp{snmppoll.LldpRemChassisIDOID: {err: &snmppoll.SnmpStatusError{Status: gosnmp.AuthorizationError}}}, OutcomeFailed, "access_denied", 0},
		{"auth rejection is failed", map[string]fakeResp{snmppoll.LldpRemChassisIDOID: {err: gosnmp.ErrWrongDigest}}, OutcomeFailed, "authentication", 0},
		{"column failure is partial", map[string]fakeResp{
			snmppoll.LldpRemChassisIDOID: {pdus: []gosnmp.SnmpPDU{octets(snmppoll.LldpRemChassisIDOID+".0.3.1", []byte("peer"))}},
			snmppoll.LldpRemPortIDOID:    {pdus: []gosnmp.SnmpPDU{octets(snmppoll.LldpRemPortIDOID+".0.3.1", []byte("Gi0/1"))}},
			snmppoll.LldpRemSysNameOID:   {err: errors.New("request timeout")},
		}, OutcomePartial, "column_failed", 1},
		{"malformed rows are partial", map[string]fakeResp{
			snmppoll.LldpRemChassisIDOID: {pdus: []gosnmp.SnmpPDU{octets(snmppoll.LldpRemChassisIDOID+".0.3.1", []byte("peer"))}},
		}, OutcomePartial, "malformed_row", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := &fakeWalker{resp: tt.resp}
			got := CollectPhysicalSections(context.Background(), w, PhysicalRequest{Target: "192.0.2.10", ContextKey: "default", Protocols: []string{SectionLLDP}})
			if len(got) != 1 {
				t.Fatalf("sections: %#v", got)
			}
			s := got[0]
			if s.Outcome != tt.wantOutcome || s.ReasonCode != tt.wantReason || len(s.Lldp) != tt.wantRows || s.RowCount != tt.wantRows {
				t.Fatalf("got %s/%s rows=%d, want %s/%s rows=%d", s.Outcome, s.ReasonCode, len(s.Lldp), tt.wantOutcome, tt.wantReason, tt.wantRows)
			}
		})
	}
}

func TestCollectPhysicalHonoursCancellation(t *testing.T) {
	w := &fakeWalker{block: true, resp: map[string]fakeResp{}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	got := CollectPhysicalSections(ctx, w, PhysicalRequest{Target: "192.0.2.10", ContextKey: "default", Protocols: allProtocols})
	if time.Since(start) > 2*time.Second {
		t.Fatal("collection ignored its deadline")
	}
	for _, s := range sectionsByKind(t, got) {
		if s.Outcome != OutcomeFailed || s.ReasonCode != "timeout" {
			t.Fatalf("deadline must fail every scope as timeout: %#v", s)
		}
	}
}

func TestUnsupportedCacheSkipsOnlyCachedNegativeCapabilities(t *testing.T) {
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	cache := NewUnsupportedCache(24*time.Hour, func() time.Time { return now })
	req := PhysicalRequest{Target: "192.0.2.10", ContextKey: "default", ConfigRevision: "rev-1", Protocols: []string{SectionCDP}, Cache: cache}
	first := &fakeWalker{resp: map[string]fakeResp{}}
	if s := CollectPhysicalSections(context.Background(), first, req)[0]; s.Outcome != OutcomeUnsupported {
		t.Fatalf("expected unsupported: %#v", s)
	}
	second := &fakeWalker{resp: map[string]fakeResp{}}
	if s := CollectPhysicalSections(context.Background(), second, req)[0]; s.Outcome != OutcomeUnsupported || second.walked(snmppoll.CdpCacheDeviceIDOID) {
		t.Fatalf("cached unsupported must not re-walk: %#v", s)
	}
	changed := req
	changed.ConfigRevision = "rev-2"
	third := &fakeWalker{resp: map[string]fakeResp{}}
	CollectPhysicalSections(context.Background(), third, changed)
	if !third.walked(snmppoll.CdpCacheDeviceIDOID) {
		t.Fatal("a configuration change must invalidate the negative cache")
	}
	now = now.Add(24*time.Hour + time.Second)
	fourth := &fakeWalker{resp: map[string]fakeResp{}}
	CollectPhysicalSections(context.Background(), fourth, req)
	if !fourth.walked(snmppoll.CdpCacheDeviceIDOID) {
		t.Fatal("negative cache entries expire after 24h")
	}
	// A timeout is never cached as unsupported.
	tcache := NewUnsupportedCache(24*time.Hour, time.Now)
	treq := req
	treq.Cache = tcache
	CollectPhysicalSections(context.Background(), &fakeWalker{resp: map[string]fakeResp{snmppoll.CdpCacheDeviceIDOID: {err: context.DeadlineExceeded}}}, treq)
	after := &fakeWalker{resp: map[string]fakeResp{}}
	CollectPhysicalSections(context.Background(), after, treq)
	if !after.walked(snmppoll.CdpCacheDeviceIDOID) {
		t.Fatal("timeout must not populate the unsupported cache")
	}
}

func TestAuthenticatedSessionIsReusedWithoutCredentialRotation(t *testing.T) {
	orig := openPhysicalSession
	t.Cleanup(func() { openPhysicalSession = orig })
	var opened []string
	good := switchWalker()
	openPhysicalSession = func(ip string, cred SNMPCredential, timeout time.Duration) (physicalSession, error) {
		opened = append(opened, cred.Community)
		switch cred.Community {
		case "wrong":
			return nil, gosnmp.ErrWrongDigest
		case "right":
			return good, nil
		}
		t.Fatalf("credential %q tried after a working session", cred.Community)
		return nil, nil
	}
	creds := []SNMPCredential{{Version: "v2c", Community: "wrong"}, {Version: "v2c", Community: "right"}, {Version: "v2c", Community: "third"}}
	res := collectPhysicalForHost(context.Background(), "192.0.2.10", creds, time.Second, PhysicalRequest{ContextKey: "default", Protocols: allProtocols})
	if len(opened) != 2 {
		t.Fatalf("empty neighbours must not rotate credentials: opened %v", opened)
	}
	if !good.closed {
		t.Fatal("session not closed")
	}
	got := sectionsByKind(t, res.Sections)
	if len(got[SectionFDB].Fdb) != 2 {
		t.Fatalf("FDB skipped on neighbour-empty session: %#v", got[SectionFDB])
	}
}

func TestNoAuthenticatedSessionFailsEveryScopeDistinctly(t *testing.T) {
	orig := openPhysicalSession
	t.Cleanup(func() { openPhysicalSession = orig })
	openPhysicalSession = func(string, SNMPCredential, time.Duration) (physicalSession, error) {
		return nil, gosnmp.ErrUnknownUsername
	}
	res := collectPhysicalForHost(context.Background(), "192.0.2.10", []SNMPCredential{{Version: "v2c", Community: "x"}}, time.Second, PhysicalRequest{ContextKey: "default", Protocols: allProtocols})
	for _, s := range sectionsByKind(t, res.Sections) {
		if s.Outcome != OutcomeFailed || s.ReasonCode != "authentication" {
			t.Fatalf("auth failure must be reported per scope without secrets: %#v", s)
		}
	}
}

func TestCollectPhysicalBoundsConcurrentTargets(t *testing.T) {
	orig := collectPhysicalFor
	t.Cleanup(func() { collectPhysicalFor = orig })
	var inflight, peak int32
	collectPhysicalFor = func(ctx context.Context, ip string, _ []SNMPCredential, _ time.Duration, req PhysicalRequest) TargetPhysical {
		n := atomic.AddInt32(&inflight, 1)
		for {
			p := atomic.LoadInt32(&peak)
			if n <= p || atomic.CompareAndSwapInt32(&peak, p, n) {
				break
			}
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Error("per-target collection must run under a deadline")
		}
		time.Sleep(10 * time.Millisecond)
		atomic.AddInt32(&inflight, -1)
		return TargetPhysical{Target: ip, Sections: []PhysicalSection{{Kind: SectionLLDP, ContextKey: req.ContextKey, Outcome: OutcomeComplete, Lldp: []LldpRow{}}}}
	}
	s := NewScanner(ScanConfig{SNMPCommunities: []string{"public"}})
	var hosts []DiscoveredHost
	for i := 1; i <= 10; i++ {
		hosts = append(hosts, DiscoveredHost{IP: "192.0.2." + itoa(i), Methods: []string{"snmp"}, SNMPData: &SNMPInfo{SysName: "sw"}})
	}
	got := s.CollectPhysical(context.Background(), hosts)
	if peak > int32(physicalTargetWorkers) || peak < 2 {
		t.Fatalf("peak concurrency %d, want 2..%d", peak, physicalTargetWorkers)
	}
	for i, r := range got {
		if r.Target != hosts[i].IP {
			t.Fatalf("results must keep host order: %d %s", i, r.Target)
		}
	}
}

func TestLegacyAdjacencyIsProjectedFromV2(t *testing.T) {
	good := switchWalker()
	good.resp[snmppoll.LldpRemChassisIDSubtypeOID] = fakeResp{pdus: []gosnmp.SnmpPDU{integer(snmppoll.LldpRemChassisIDSubtypeOID+".400.7.1", 4)}}
	good.resp[snmppoll.LldpRemChassisIDOID] = fakeResp{pdus: []gosnmp.SnmpPDU{octets(snmppoll.LldpRemChassisIDOID+".400.7.1", []byte{2, 0, 0, 0, 0, 1})}}
	good.resp[snmppoll.LldpRemPortIDOID] = fakeResp{pdus: []gosnmp.SnmpPDU{octets(snmppoll.LldpRemPortIDOID+".400.7.1", []byte("Gi0/1"))}}
	sections := CollectPhysicalSections(context.Background(), good, PhysicalRequest{Target: "192.0.2.10", ContextKey: "default", Protocols: allProtocols})
	legacy := LegacyAdjacencyFromSections("192.0.2.10", sections)
	if len(legacy.Lldp) != 1 || legacy.Lldp[0].LocalPort != "7" || legacy.Lldp[0].LocalIfName != "ge-0/0/7" || legacy.Lldp[0].RemoteChassisID != "02:00:00:00:00:01" {
		t.Fatalf("legacy LLDP: %#v", legacy.Lldp)
	}
	if len(legacy.Cdp) != 0 || len(legacy.Fdb) != 2 || legacy.Fdb[0].IfName != "ge-0/0/7" || legacy.Fdb[0].VLAN != 0 {
		t.Fatalf("legacy CDP/FDB: %#v %#v", legacy.Cdp, legacy.Fdb)
	}
}

func TestCollectPhysicalFDBUsesQBridgeTuplesAndBoundedWalks(t *testing.T) {
	w := switchWalker()
	w.resp[snmppoll.Dot1dTpFdbPortOID] = fakeResp{} // legacy BRIDGE table empty
	w.resp[snmppoll.Dot1qTpFdbPortOID] = fakeResp{pdus: []gosnmp.SnmpPDU{
		integer(snmppoll.Dot1qTpFdbPortOID+".700.2.0.0.0.0.16", 7),
		integer(snmppoll.Dot1qTpFdbPortOID+".701.2.0.0.0.0.16", 8),
	}}
	w.resp[snmppoll.Dot1qTpFdbStatusOID] = fakeResp{pdus: []gosnmp.SnmpPDU{integer(snmppoll.Dot1qTpFdbStatusOID+".700.2.0.0.0.0.16", 3)}}
	w.resp[snmppoll.Dot1qVlanFdbIDOID] = fakeResp{pdus: []gosnmp.SnmpPDU{
		integer(snmppoll.Dot1qVlanFdbIDOID+".0.10", 700), integer(snmppoll.Dot1qVlanFdbIDOID+".0.20", 700),
	}}
	s := sectionsByKind(t, CollectPhysicalSections(context.Background(), w, PhysicalRequest{Target: "192.0.2.10", ContextKey: "default", Protocols: []string{SectionFDB}}))[SectionFDB]
	if s.Outcome != OutcomeComplete || len(s.Fdb) != 2 || s.RowCount != 2 {
		t.Fatalf("Q-BRIDGE-only switch: %#v", s)
	}
	r := s.Fdb[0]
	if r.FDBID == nil || *r.FDBID != 700 || len(r.VLANs) != 2 || r.VLANMapping != snmppoll.VLANMappingComplete || r.Status != snmppoll.FdbStatusLearned || r.IfName != "ge-0/0/7" {
		t.Fatalf("tuple: %#v", r)
	}
	if s.Fdb[1].VLANMapping != snmppoll.VLANMappingUnknown {
		t.Fatalf("unmapped FDB id must stay unknown: %#v", s.Fdb[1])
	}
	for _, oid := range []string{snmppoll.Dot1dTpFdbPortOID, snmppoll.Dot1qTpFdbPortOID, snmppoll.Dot1dTpFdbStatusOID, snmppoll.Dot1qTpFdbStatusOID, snmppoll.Dot1qVlanFdbIDOID} {
		if w.bounds[oid] != AdjacencyV2FDBMaxRows {
			t.Fatalf("%s must be walked with a pre-allocation bound, got %d", oid, w.bounds[oid])
		}
	}
}

func TestCollectPhysicalFDBTruncationIsPartialLimit(t *testing.T) {
	w := switchWalker()
	var many []gosnmp.SnmpPDU
	for i := 0; i < AdjacencyV2FDBMaxRows+5; i++ {
		many = append(many, integer(snmppoll.Dot1dTpFdbPortOID+".2.0."+itoa((i>>16)&255)+"."+itoa((i>>8)&255)+"."+itoa(i&255)+".1", 7))
	}
	w.resp[snmppoll.Dot1dTpFdbPortOID] = fakeResp{pdus: many}
	s := sectionsByKind(t, CollectPhysicalSections(context.Background(), w, PhysicalRequest{Target: "192.0.2.10", ContextKey: "default", Protocols: []string{SectionFDB}}))[SectionFDB]
	if s.Outcome != OutcomePartial || s.ReasonCode != "limit_exceeded" || len(s.Fdb) > AdjacencyV2FDBMaxRows {
		t.Fatalf("truncation must be partial/limit_exceeded within the bound: %s/%s rows=%d", s.Outcome, s.ReasonCode, len(s.Fdb))
	}
}

// M2 Task 6b: the target's own LLDP chassis (lldpLocChassisIdSubtype/-Id) is
// carried on the interfaces section so the server can recognise the target
// when a neighbour reports that chassis (a base MAC often matches no ifPhysAddress).
func TestCollectPhysicalCarriesTargetLLDPChassis(t *testing.T) {
	w := switchWalker()
	w.resp[snmppoll.LldpLocChassisIDSubtypeOID] = fakeResp{pdus: []gosnmp.SnmpPDU{integer(snmppoll.LldpLocChassisIDSubtypeOID+".0", 4)}}
	w.resp[snmppoll.LldpLocChassisIDOID] = fakeResp{pdus: []gosnmp.SnmpPDU{octets(snmppoll.LldpLocChassisIDOID+".0", []byte{2, 0, 0, 0, 1, 0})}}
	got := sectionsByKind(t, CollectPhysicalSections(context.Background(), w, PhysicalRequest{Target: "192.0.2.10", ContextKey: "default", Protocols: allProtocols}))
	ifs := got[SectionInterfaces]
	if ifs.LocalChassis == nil || *ifs.LocalChassis != (TypedID{Subtype: "mac_address", Value: "02:00:00:00:01:00"}) {
		t.Fatalf("interfaces section lost the target's own chassis: %#v", ifs.LocalChassis)
	}
	if got[SectionLLDP].LocalChassis != nil {
		t.Fatal("only the interfaces section carries the target chassis")
	}
	b, err := json.Marshal(ifs)
	if err != nil || !strings.Contains(string(b), `"localChassis":{"subtype":"mac_address","value":"02:00:00:00:01:00"}`) {
		t.Fatalf("wire form: %s %v", b, err)
	}

	// Absent/failed scalars: no field at all (digest-identical to the old contract).
	plain := sectionsByKind(t, CollectPhysicalSections(context.Background(), switchWalker(), PhysicalRequest{Target: "192.0.2.10", ContextKey: "default", Protocols: allProtocols}))
	if plain[SectionInterfaces].LocalChassis != nil {
		t.Fatalf("unexpected chassis: %#v", plain[SectionInterfaces].LocalChassis)
	}
	if b, _ := json.Marshal(plain[SectionInterfaces]); strings.Contains(string(b), "localChassis") {
		t.Fatalf("absent chassis must not be marshalled: %s", b)
	}
}
