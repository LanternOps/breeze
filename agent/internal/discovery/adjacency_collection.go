package discovery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/gosnmp/gosnmp"
)

// Physical collection (Collection spec §7): for each authorized SNMP target,
// LLDP, CDP, bridge FDB and interface inventory are attempted independently on
// ONE authenticated session. Every requested scope gets an explicit outcome;
// a neighbour-empty session neither rotates credentials nor skips FDB.

// Defaults: 30 s per target, four targets in flight per collector.
var (
	physicalTargetWorkers   = 4
	physicalTargetBudget    = 30 * time.Second
	physicalUnsupportedTTL  = 24 * time.Hour
	physicalUnsupportedPool = NewUnsupportedCache(physicalUnsupportedTTL, time.Now)
)

var physicalSectionLimits = map[string]int{SectionLLDP: 4096, SectionCDP: 4096, SectionFDB: AdjacencyV2FDBMaxRows, SectionInterfaces: 4096}

// PhysicalWalker walks one subtree on an already-authenticated session. It must
// honour ctx and never return credentials in results.
type PhysicalWalker interface {
	Walk(ctx context.Context, oid string) ([]gosnmp.SnmpPDU, error)
}

// PhysicalRequest declares the authorized scope of one target collection.
type PhysicalRequest struct {
	Target         string
	ContextKey     string
	ConfigRevision string   // changes invalidate the negative capability cache
	Protocols      []string // subset of lldp|cdp|fdb|interfaces
	Cache          *UnsupportedCache
}

// TargetPhysical is one target's sections.
type TargetPhysical struct {
	Target   string
	Sections []PhysicalSection
}

// UnsupportedCache remembers negative capability answers (never timeouts) per
// target/config/context/protocol for a bounded TTL.
type UnsupportedCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	now     func() time.Time
	entries map[string]time.Time
}

func NewUnsupportedCache(ttl time.Duration, now func() time.Time) *UnsupportedCache {
	return &UnsupportedCache{ttl: ttl, now: now, entries: map[string]time.Time{}}
}

func (c *UnsupportedCache) key(req PhysicalRequest, protocol string) string {
	return strings.Join([]string{req.Target, req.ConfigRevision, req.ContextKey, protocol}, "\x00")
}

func (c *UnsupportedCache) unsupported(req PhysicalRequest, protocol string) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	k := c.key(req, protocol)
	at, ok := c.entries[k]
	if ok && c.now().Sub(at) > c.ttl {
		delete(c.entries, k)
		return false
	}
	return ok
}

func (c *UnsupportedCache) remember(req PhysicalRequest, protocol string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, at := range c.entries { // opportunistic expiry keeps the map bounded
		if now.Sub(at) > c.ttl {
			delete(c.entries, k)
		}
	}
	c.entries[c.key(req, protocol)] = now
}

type column struct {
	pdus   []gosnmp.SnmpPDU
	err    error
	noSuch bool // the agent answered with noSuchObject/noSuchInstance
}

func walkColumn(ctx context.Context, w PhysicalWalker, oid string) column {
	if err := ctx.Err(); err != nil {
		return column{err: err}
	}
	pdus, err := w.Walk(ctx, oid)
	if err != nil {
		return column{err: err}
	}
	c := column{pdus: make([]gosnmp.SnmpPDU, 0, len(pdus))}
	for _, p := range pdus {
		switch p.Type {
		case gosnmp.NoSuchObject, gosnmp.NoSuchInstance, gosnmp.EndOfMibView:
			c.noSuch = true
			continue
		}
		if indexSuffix(p.Name, oid) != "" {
			c.pdus = append(c.pdus, p)
		}
	}
	return c
}

// walkReason maps a walk/session error to a bounded reason code. No error text
// (which could echo a community or user) leaves this function.
func walkReason(err error) string {
	var status *snmppoll.SnmpStatusError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.As(err, &status):
		switch status.Status {
		case gosnmp.NoAccess, gosnmp.AuthorizationError:
			return "access_denied"
		case gosnmp.NoSuchName:
			return "not_supported"
		}
		return "walk_error"
	}
	switch classifySNMPProbeError(err) {
	case "credentials_rejected":
		return "authentication"
	case "no_response":
		return "timeout"
	}
	return "walk_error"
}

func newSection(kind, contextKey string) PhysicalSection {
	s := PhysicalSection{Kind: kind, ContextKey: contextKey, Outcome: OutcomeComplete}
	switch kind {
	case SectionLLDP:
		s.Lldp = []LldpRow{}
	case SectionCDP:
		s.Cdp = []CdpRow{}
	case SectionFDB:
		s.Fdb = []FdbRow{}
	case SectionInterfaces:
		s.Interfaces = []PhysicalInterfaceRow{}
	}
	return s
}

func (s PhysicalSection) withOutcome(o Outcome, reason string) PhysicalSection {
	s.Outcome, s.ReasonCode = o, reason
	if o == OutcomeFailed || o == OutcomeUnsupported || o == OutcomeNotAttempted {
		s = newSection(s.Kind, s.ContextKey)
		s.Outcome, s.ReasonCode = o, reason
	}
	s.RowCount = s.Len()
	return s
}

// finish applies the row bound and partial reasons to a section with rows.
func (s PhysicalSection) finish(columnFailed bool, malformed int) PhysicalSection {
	limit := physicalSectionLimits[s.Kind]
	if n := s.Len(); n > limit {
		switch s.Kind {
		case SectionLLDP:
			s.Lldp = s.Lldp[:limit]
		case SectionCDP:
			s.Cdp = s.Cdp[:limit]
		case SectionFDB:
			s.Fdb = s.Fdb[:limit]
		case SectionInterfaces:
			s.Interfaces = s.Interfaces[:limit]
		}
		s.OmittedRowCount = n - limit
		return s.withOutcome(OutcomePartial, "limit_exceeded")
	}
	switch {
	case columnFailed:
		return s.withOutcome(OutcomePartial, "column_failed")
	case malformed > 0:
		return s.withOutcome(OutcomePartial, "malformed_row")
	}
	return s.withOutcome(OutcomeComplete, "")
}

func requested(req PhysicalRequest, kind string) bool {
	for _, p := range req.Protocols {
		if p == kind {
			return true
		}
	}
	return false
}

// physicalRun holds the per-target tables shared between sections.
type physicalRun struct {
	ctx      context.Context
	w        PhysicalWalker
	req      PhysicalRequest
	ifCols   InterfaceColumns
	ifErrs   []error
	inv      []InterfaceIdentity
	locCols  LLDPColumns
	locErr   error
	lldpPort map[uint32]string
}

// CollectPhysicalSections walks the requested protocols for one authenticated
// target and returns exactly one section per requested protocol, in canonical
// order (lldp, cdp, fdb, interfaces).
func CollectPhysicalSections(ctx context.Context, walker PhysicalWalker, request PhysicalRequest) []PhysicalSection {
	r := &physicalRun{ctx: ctx, w: walker, req: request}
	if len(request.Protocols) == 0 {
		return []PhysicalSection{}
	}
	r.walkInventory()
	if requested(request, SectionLLDP) || requested(request, SectionInterfaces) {
		r.walkLLDPLocal()
	}
	sections := []PhysicalSection{}
	for _, kind := range []string{SectionLLDP, SectionCDP, SectionFDB, SectionInterfaces} {
		if !requested(request, kind) {
			continue
		}
		if request.Cache.unsupported(request, kind) {
			sections = append(sections, newSection(kind, request.ContextKey).withOutcome(OutcomeUnsupported, "not_supported"))
			continue
		}
		var s PhysicalSection
		switch kind {
		case SectionLLDP:
			s = r.collectLLDPSection()
		case SectionCDP:
			s = r.collectCDPSection()
		case SectionFDB:
			s = r.collectFDBSection()
		case SectionInterfaces:
			s = r.collectInterfaceSection()
		}
		if s.Outcome == OutcomeUnsupported {
			request.Cache.remember(request, kind)
		}
		sections = append(sections, s)
	}
	return sections
}

func (r *physicalRun) walkInventory() {
	walk := func(oid string) []gosnmp.SnmpPDU {
		c := walkColumn(r.ctx, r.w, oid)
		r.ifErrs = append(r.ifErrs, c.err)
		return c.pdus
	}
	r.ifCols = InterfaceColumns{
		IfName:          walk(snmppoll.IfNameOID),
		IfAlias:         walk(snmppoll.IfAliasOID),
		IfPhysAddress:   walk(snmppoll.IfPhysAddressOID),
		BasePortIfIndex: walk(snmppoll.Dot1dBasePortIfIndexOID),
	}
	r.inv = BuildInterfaceInventory(r.ifCols)
}

func (r *physicalRun) walkLLDPLocal() {
	sub := walkColumn(r.ctx, r.w, snmppoll.LldpLocPortIDSubtypeOID)
	id := walkColumn(r.ctx, r.w, snmppoll.LldpLocPortIDOID)
	r.locCols = LLDPColumns{LocalPortIDSubtype: sub.pdus, LocalPortID: id.pdus}
	r.locErr = id.err
	if r.locErr == nil {
		r.locErr = sub.err
	}
	r.lldpPort = ResolveLLDPLocalPorts(r.locCols, r.inv)
}

func (r *physicalRun) collectLLDPSection() PhysicalSection {
	s := newSection(SectionLLDP, r.req.ContextKey)
	chassis := walkColumn(r.ctx, r.w, snmppoll.LldpRemChassisIDOID)
	if chassis.err != nil {
		return s.withOutcome(OutcomeFailed, walkReason(chassis.err))
	}
	if len(chassis.pdus) == 0 {
		switch {
		case chassis.noSuch:
			return s.withOutcome(OutcomeUnsupported, "not_supported")
		case len(r.locCols.LocalPortID) > 0: // LLDP is running and saw no neighbours
			return s.withOutcome(OutcomeComplete, "")
		case r.locErr != nil:
			return s.withOutcome(OutcomeFailed, walkReason(r.locErr))
		}
		return s.withOutcome(OutcomeUnsupported, "not_supported")
	}
	cols := r.locCols
	cols.RemoteChassis = chassis.pdus
	failed := false
	for _, c := range []struct {
		oid string
		dst *[]gosnmp.SnmpPDU
	}{
		{snmppoll.LldpRemChassisIDSubtypeOID, &cols.RemoteChassisSubtype},
		{snmppoll.LldpRemPortIDSubtypeOID, &cols.RemotePortSubtype},
		{snmppoll.LldpRemPortIDOID, &cols.RemotePort},
		{snmppoll.LldpRemSysNameOID, &cols.RemoteSysName},
		{snmppoll.LldpRemManAddrIfSubtypeOID, &cols.RemoteManAddr},
	} {
		got := walkColumn(r.ctx, r.w, c.oid)
		*c.dst = got.pdus
		failed = failed || got.err != nil
	}
	rows, malformed := parseLLDPV2(cols, r.inv)
	s.Lldp = rows
	return s.finish(failed, malformed)
}

func (r *physicalRun) collectCDPSection() PhysicalSection {
	s := newSection(SectionCDP, r.req.ContextKey)
	dev := walkColumn(r.ctx, r.w, snmppoll.CdpCacheDeviceIDOID)
	if dev.err != nil {
		return s.withOutcome(OutcomeFailed, walkReason(dev.err))
	}
	if len(dev.pdus) == 0 {
		if dev.noSuch {
			return s.withOutcome(OutcomeUnsupported, "not_supported")
		}
		probe := walkColumn(r.ctx, r.w, snmppoll.CdpGlobalOID)
		switch {
		case probe.err != nil:
			return s.withOutcome(OutcomeFailed, walkReason(probe.err))
		case len(probe.pdus) == 0:
			return s.withOutcome(OutcomeUnsupported, "not_supported")
		}
		return s.withOutcome(OutcomeComplete, "")
	}
	cols := CDPColumns{DeviceID: dev.pdus}
	port := walkColumn(r.ctx, r.w, snmppoll.CdpCacheDevicePortOID)
	typ := walkColumn(r.ctx, r.w, snmppoll.CdpCacheAddressTypeOID)
	addr := walkColumn(r.ctx, r.w, snmppoll.CdpCacheAddressOID)
	cols.DevicePort, cols.AddressType, cols.Address = port.pdus, typ.pdus, addr.pdus
	rows, malformed := parseCDPV2(cols, r.inv)
	s.Cdp = rows
	return s.finish(port.err != nil || typ.err != nil || addr.err != nil, malformed)
}

// collectFDBSection (bounded adapter): BRIDGE-MIB positives only, with no FDB
// id and unknown VLAN mapping. Q-BRIDGE coverage is not claimed, so a section
// with rows is partial. Replaced by the tuple-based assembler.
func (r *physicalRun) collectFDBSection() PhysicalSection {
	s := newSection(SectionFDB, r.req.ContextKey)
	fdb := walkColumn(r.ctx, r.w, snmppoll.Dot1dTpFdbPortOID)
	if fdb.err != nil {
		return s.withOutcome(OutcomeFailed, walkReason(fdb.err))
	}
	if len(fdb.pdus) == 0 && (fdb.noSuch || len(r.ifCols.BasePortIfIndex) == 0) {
		return s.withOutcome(OutcomeUnsupported, "not_supported")
	}
	ifIndexOf := map[uint32]uint32{}
	for _, i := range r.inv {
		if i.BridgePort != nil {
			ifIndexOf[*i.BridgePort] = i.IfIndex
		}
	}
	for _, e := range snmppoll.AssembleFdbEntries(fdb.pdus, r.ifCols.BasePortIfIndex, r.ifCols.IfName, nil) {
		port := uint32(e.BridgePort)
		row := FdbRow{BridgeContext: r.req.ContextKey, MAC: e.MAC, BridgePort: port, Status: snmppoll.FdbStatusOther,
			VLANs: []uint16{}, VLANMapping: snmppoll.VLANMappingUnknown, IfName: e.IfName}
		if idx, ok := ifIndexOf[port]; ok {
			idx := idx
			row.IfIndex = &idx
		}
		if !validKey(row.IfName) {
			row.IfName = ""
		}
		row.RowKey = snmppoll.FdbV2RowKey(row.BridgeContext, nil, row.MAC, row.BridgePort)
		s.Fdb = append(s.Fdb, row)
	}
	sort.Slice(s.Fdb, func(a, b int) bool { return s.Fdb[a].RowKey < s.Fdb[b].RowKey })
	s = s.finish(false, 0)
	if s.Outcome == OutcomeComplete {
		s = s.withOutcome(OutcomePartial, "qbridge_not_collected")
	}
	return s
}

func (r *physicalRun) collectInterfaceSection() PhysicalSection {
	s := newSection(SectionInterfaces, r.req.ContextKey)
	var firstErr error
	failed := 0
	for _, e := range r.ifErrs {
		if e != nil {
			failed++
			if firstErr == nil {
				firstErr = e
			}
		}
	}
	// ifName (0) and ifPhysAddress (2) are the identity columns.
	if r.ifErrs[0] != nil && r.ifErrs[2] != nil {
		return s.withOutcome(OutcomeFailed, walkReason(firstErr))
	}
	if len(r.inv) == 0 {
		if firstErr != nil {
			return s.withOutcome(OutcomeFailed, walkReason(firstErr))
		}
		return s.withOutcome(OutcomeUnsupported, "not_supported")
	}
	s.Interfaces = interfaceRows(r.inv, r.lldpPort)
	return s.finish(failed > 0, 0)
}

// ---- sessions and targets ----

type physicalSession interface {
	PhysicalWalker
	Close()
}

// openPhysicalSession opens one SNMP session and proves the credential with a
// system-group GET. It is the per-host network seam (stubbed in tests).
var openPhysicalSession = openAuthenticatedSNMPSession

func openAuthenticatedSNMPSession(ip string, cred SNMPCredential, timeout time.Duration) (physicalSession, error) {
	client, err := snmppoll.NewClient(cred.clientConfig(ip, timeout))
	if err != nil {
		return nil, err
	}
	if _, err := client.GetMulti(sysOIDs); err != nil {
		client.Close()
		return nil, err
	}
	return &snmpWalker{client: client}, nil
}

// snmpWalker adapts the ctx-less snmppoll client: walks page with WalkBounded
// and stop at the first page boundary after ctx is done, so cancellation
// latency is one request timeout. Calls are serialized on the session.
type snmpWalker struct {
	mu     sync.Mutex
	client *snmppoll.SNMPClient
}

func (w *snmpWalker) Walk(ctx context.Context, oid string) ([]gosnmp.SnmpPDU, error) {
	pdus, _, err := w.WalkBounded(ctx, oid, 0)
	return pdus, err
}

// WalkBounded stops after maxRows PDUs (0 = unbounded) and reports truncation
// without buffering the remainder of the subtree.
func (w *snmpWalker) WalkBounded(ctx context.Context, oid string, maxRows int) ([]gosnmp.SnmpPDU, bool, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	errTruncated := errors.New("truncated")
	var out []gosnmp.SnmpPDU
	err := w.client.WalkBounded(oid, func(p gosnmp.SnmpPDU) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if maxRows > 0 && len(out) >= maxRows {
			return errTruncated
		}
		out = append(out, p)
		return nil
	})
	if errors.Is(err, errTruncated) {
		return out, true, nil
	}
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, false, ctxErr
		}
		return nil, false, err
	}
	return out, false, nil
}

func (w *snmpWalker) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.client.Close()
}

// collectPhysicalFor is the per-target seam (stubbed in tests).
var collectPhysicalFor = collectPhysicalForHost

// collectPhysicalForHost authenticates once, then collects every requested
// scope on that session. Credentials rotate only when a session cannot be
// established — never because a working session returned empty tables.
func collectPhysicalForHost(ctx context.Context, ip string, creds []SNMPCredential, timeout time.Duration, req PhysicalRequest) TargetPhysical {
	req.Target = ip
	var lastErr error
	for _, cred := range creds {
		if !cred.usable() {
			continue
		}
		if err := ctx.Err(); err != nil {
			lastErr = err
			break
		}
		sess, err := openPhysicalSession(ip, cred, timeout)
		if err != nil {
			lastErr = err
			slog.Debug("SNMP physical session failed", "target", ip, "credential", cred.Describe(), "class", classifySNMPProbeError(err))
			continue
		}
		sections := CollectPhysicalSections(ctx, sess, req)
		sess.Close()
		return TargetPhysical{Target: ip, Sections: sections}
	}
	reason := "no_usable_credentials"
	if lastErr != nil {
		reason = walkReason(lastErr)
	}
	sections := []PhysicalSection{}
	for _, kind := range []string{SectionLLDP, SectionCDP, SectionFDB, SectionInterfaces} {
		if requested(req, kind) {
			sections = append(sections, newSection(kind, req.ContextKey).withOutcome(OutcomeFailed, reason))
		}
	}
	return TargetPhysical{Target: ip, Sections: sections}
}

// credentialRevision fingerprints the credential set (non-secret descriptions)
// so a configuration change invalidates cached negative capabilities.
func credentialRevision(creds []SNMPCredential) string {
	h := sha256.New()
	for _, c := range creds {
		h.Write([]byte(c.Describe()))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// CollectPhysical collects every SNMP responder with a bounded worker pool and
// a per-target deadline. Results keep host order.
func (s *Scanner) CollectPhysical(ctx context.Context, hosts []DiscoveredHost) []TargetPhysical {
	creds := s.config.SNMPCredentials
	if len(creds) == 0 {
		return nil
	}
	var targets []string
	for _, h := range hosts {
		if h.SNMPData != nil && hasMethod(h.Methods, "snmp") {
			targets = append(targets, h.IP)
		}
	}
	out := make([]TargetPhysical, len(targets))
	req := PhysicalRequest{ContextKey: "default", ConfigRevision: credentialRevision(creds), Cache: physicalUnsupportedPool,
		Protocols: []string{SectionLLDP, SectionCDP, SectionFDB, SectionInterfaces}}
	jobs := make(chan int)
	var wg sync.WaitGroup
	workers := physicalTargetWorkers
	if workers > len(targets) {
		workers = len(targets)
	}
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				tctx, cancel := context.WithTimeout(ctx, physicalTargetBudget)
				out[i] = collectPhysicalFor(tctx, targets[i], creds, s.config.Timeout, req)
				cancel()
			}
		}()
	}
	for i := range targets {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	return out
}
