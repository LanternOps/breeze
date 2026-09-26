package networkdiagnostic

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
)

// ---------------------------------------------------------------------------
// Fakes. No test in this file opens a socket or runs an external program.
// ---------------------------------------------------------------------------

type traceCall struct {
	TTL, Attempt int
	Destination  netip.Addr
	Source       SourceBinding
	HopBudget    time.Duration
}

type fakeTraceTransport struct {
	mu         sync.Mutex
	replies    map[int]TraceReply    // by TTL, every attempt
	perAttempt map[[2]int]TraceReply // by (TTL, attempt), overrides replies
	errs       map[[2]int]error
	block      bool // unanswered probes wait for the caller's deadline
	onProbe    func(ttl, attempt int)
	Calls      []traceCall
}

func newFakeTraceTransport(replies map[int]TraceReply) *fakeTraceTransport {
	return &fakeTraceTransport{replies: replies, perAttempt: map[[2]int]TraceReply{}, errs: map[[2]int]error{}}
}

func (f *fakeTraceTransport) Probe(ctx context.Context, ttl, attempt int, destination netip.Addr, source SourceBinding) (TraceReply, error) {
	budget := time.Duration(0)
	if deadline, ok := ctx.Deadline(); ok {
		budget = time.Until(deadline)
	}
	f.mu.Lock()
	f.Calls = append(f.Calls, traceCall{ttl, attempt, destination, source, budget})
	hook := f.onProbe
	reply, ok := f.perAttempt[[2]int{ttl, attempt}]
	if !ok {
		reply, ok = f.replies[ttl]
	}
	err := f.errs[[2]int{ttl, attempt}]
	f.mu.Unlock()
	if hook != nil {
		hook(ttl, attempt)
	}
	if err != nil {
		return TraceReply{}, err
	}
	if ctx.Err() != nil {
		return TraceReply{}, ctx.Err()
	}
	if ok {
		if reply.Kind == 0 {
			reply.Kind = TraceTimeExceeded
			if reply.Address == destination {
				reply.Kind = TraceEchoReply
			}
		}
		if reply.RTT == 0 {
			reply.RTT = 1500 * time.Microsecond
		}
		return reply, nil
	}
	if f.block {
		<-ctx.Done()
		return TraceReply{}, ctx.Err()
	}
	return TraceReply{}, context.DeadlineExceeded
}

func reply(address string) TraceReply { return TraceReply{Address: netip.MustParseAddr(address)} }

func tracePlan(maxHops, probes int) TracePlan {
	return TracePlan{
		Destination:  netip.MustParseAddr("192.0.2.3"),
		Source:       SourceBinding{Address: netip.MustParseAddr("192.0.2.10"), InterfaceKey: "if1", OSIndex: 7, ContextKey: "ctx"},
		MaxHops:      maxHops,
		ProbesPerHop: probes,
		HopTimeout:   time.Second,
		Quality:      "observed",
	}
}

func deadlineCtx(t *testing.T, d time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}

// ---------------------------------------------------------------------------
// RunTrace: bounded probing semantics.
// ---------------------------------------------------------------------------

func TestTraceRetainsTimeoutGap(t *testing.T) {
	fake := newFakeTraceTransport(map[int]TraceReply{1: reply("192.0.2.1"), 3: reply("192.0.2.3")})
	got := RunTrace(deadlineCtx(t, 10*time.Second), tracePlan(3, 1), fake)
	if len(got.Details.Hops) != 3 || got.Details.Hops[1].Outcome != "timeout" {
		t.Fatalf("lost gap: %#v", got)
	}
	gap := got.Details.Hops[1]
	if gap.Address != nil || gap.RTTMS != nil || gap.AttributionQuality != "unknown" || gap.TTL != 2 {
		t.Fatalf("an unanswered hop invented evidence: %#v", gap)
	}
	if len(fake.Calls) != 3 {
		t.Fatalf("unexpected fanout: %d", len(fake.Calls))
	}
	if !got.Details.DestinationReached || got.Stop != TraceStopDestinationReached {
		t.Fatalf("destination confirmation lost: %#v", got)
	}
	if first := got.Details.Hops[0]; first.Address == nil || *first.Address != "192.0.2.1" || first.Outcome != "reply" || first.AttributionQuality != "observed" || first.RTTMS == nil {
		t.Fatalf("responder not retained: %#v", first)
	}
}

func TestTraceStopsAfterDestinationConfirmation(t *testing.T) {
	fake := newFakeTraceTransport(map[int]TraceReply{1: reply("192.0.2.1"), 2: reply("192.0.2.3")})
	got := RunTrace(deadlineCtx(t, 10*time.Second), tracePlan(30, 2), fake)
	// TTL1 x2 attempts, then TTL2 attempt 1 confirms the destination.
	if len(fake.Calls) != 3 || !got.Details.DestinationReached {
		t.Fatalf("probed past the destination: %d calls %#v", len(fake.Calls), got)
	}
	for i, call := range fake.Calls {
		if call.Destination != netip.MustParseAddr("192.0.2.3") || call.Source.InterfaceKey != "if1" {
			t.Fatalf("call %d left the pinned destination/source: %#v", i, call)
		}
	}
}

func TestTraceRejectsUnboundedPlans(t *testing.T) {
	for name, plan := range map[string]TracePlan{
		"31 hops":        tracePlan(31, 1),
		"3 probes":       tracePlan(16, 3),
		"zero hops":      tracePlan(0, 1),
		"no destination": func() TracePlan { p := tracePlan(16, 1); p.Destination = netip.Addr{}; return p }(),
	} {
		fake := newFakeTraceTransport(nil)
		got := RunTrace(deadlineCtx(t, time.Second), plan, fake)
		if got.Stop != TraceStopInvalidPlan || len(fake.Calls) != 0 || len(got.Details.Hops) != 0 {
			t.Fatalf("%s: unbounded plan probed: %#v calls=%d", name, got, len(fake.Calls))
		}
	}
}

func TestTraceHopTimeoutNeverExceedsOneSecond(t *testing.T) {
	plan := tracePlan(2, 1)
	plan.HopTimeout = 5 * time.Second
	fake := newFakeTraceTransport(nil)
	RunTrace(deadlineCtx(t, 10*time.Second), plan, fake)
	if len(fake.Calls) != 2 {
		t.Fatalf("calls: %d", len(fake.Calls))
	}
	for _, call := range fake.Calls {
		if call.HopBudget <= 0 || call.HopBudget > time.Second {
			t.Fatalf("hop budget %s exceeds the one-second hop timeout", call.HopBudget)
		}
	}
}

func TestTraceStopsAtTheExecutionDeadlineWithoutInventingGaps(t *testing.T) {
	fake := newFakeTraceTransport(map[int]TraceReply{1: reply("192.0.2.1")})
	fake.block = true
	started := time.Now()
	got := RunTrace(deadlineCtx(t, 150*time.Millisecond), tracePlan(30, 2), fake)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("trace outlived its deadline: %s", elapsed)
	}
	if got.Stop != TraceStopExecutionDeadline {
		t.Fatalf("stop: %#v", got)
	}
	// TTL1 answered twice; the probe cut short by the RUN deadline is not a hop timeout.
	for _, hop := range got.Details.Hops {
		if hop.Outcome == "timeout" {
			t.Fatalf("deadline-cut probe recorded as a hop gap: %#v", got.Details.Hops)
		}
	}
	if len(got.Details.Hops) != 2 {
		t.Fatalf("answered hops lost: %#v", got.Details.Hops)
	}
}

func TestTraceCancellationKeepsPartialEvidence(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := newFakeTraceTransport(map[int]TraceReply{1: reply("192.0.2.1"), 2: reply("192.0.2.2")})
	fake.onProbe = func(ttl, _ int) {
		if ttl == 3 {
			cancel()
		}
	}
	got := RunTrace(ctx, tracePlan(30, 1), fake)
	if got.Stop != TraceStopCancelled || len(got.Details.Hops) != 2 || len(fake.Calls) != 3 {
		t.Fatalf("cancellation: calls=%d %#v", len(fake.Calls), got)
	}
}

func TestTraceKeepsECMPAlternativesAtOneTTL(t *testing.T) {
	fake := newFakeTraceTransport(map[int]TraceReply{3: reply("192.0.2.3")})
	fake.perAttempt[[2]int{1, 1}] = reply("192.0.2.1")
	fake.perAttempt[[2]int{1, 2}] = reply("198.51.100.1")
	got := RunTrace(deadlineCtx(t, 10*time.Second), tracePlan(30, 2), fake)
	if len(got.Details.Hops) < 2 || *got.Details.Hops[0].Address != "192.0.2.1" || *got.Details.Hops[1].Address != "198.51.100.1" || got.Details.Hops[1].Attempt != 2 {
		t.Fatalf("ECMP alternative collapsed: %#v", got.Details.Hops)
	}
}

func TestTraceUnsupportedTransportIsExplicit(t *testing.T) {
	fake := newFakeTraceTransport(nil)
	fake.errs[[2]int{1, 1}] = ErrTraceUnsupported
	got := RunTrace(deadlineCtx(t, time.Second), tracePlan(16, 1), fake)
	if got.Stop != TraceStopUnsupported || len(fake.Calls) != 1 || len(got.Details.Hops) != 1 || got.Details.Hops[0].Outcome != "unsupported" || got.Details.Hops[0].Address != nil {
		t.Fatalf("unsupported: %#v", got)
	}
}

func TestTraceUnreachableStopsWithTheReportingRouter(t *testing.T) {
	fake := newFakeTraceTransport(map[int]TraceReply{1: reply("192.0.2.1"), 2: {Address: netip.MustParseAddr("192.0.2.2"), Kind: TraceUnreachable}})
	got := RunTrace(deadlineCtx(t, time.Second), tracePlan(16, 1), fake)
	if got.Stop != TraceStopUnreachable || len(fake.Calls) != 2 || got.Details.Hops[1].Outcome != "unreachable" || *got.Details.Hops[1].Address != "192.0.2.2" || got.Details.DestinationReached {
		t.Fatalf("unreachable: %#v", got)
	}
}

func TestTraceProbeErrorIsNotAGap(t *testing.T) {
	fake := newFakeTraceTransport(map[int]TraceReply{1: reply("192.0.2.1")})
	fake.errs[[2]int{2, 1}] = errors.New("sendto: no buffer space available")
	got := RunTrace(deadlineCtx(t, time.Second), tracePlan(16, 1), fake)
	if got.Stop != TraceStopProbeFailed || len(got.Details.Hops) != 1 {
		t.Fatalf("an I/O failure became evidence: %#v", got)
	}
}

func TestTraceTruncatesToTheStepByteBudget(t *testing.T) {
	fake := newFakeTraceTransport(nil)
	for ttl := 1; ttl <= 30; ttl++ {
		for attempt := 1; attempt <= 2; attempt++ {
			fake.perAttempt[[2]int{ttl, attempt}] = TraceReply{Address: netip.MustParseAddr("2001:db8:ffff:ffff:ffff:ffff:ffff:" + hex.EncodeToString([]byte{byte(ttl), byte(attempt)})), Kind: TraceTimeExceeded, RTT: 999999 * time.Microsecond}
		}
	}
	plan := tracePlan(30, 2)
	plan.Destination = netip.MustParseAddr("2001:db8::99")
	plan.Quality = "requested_unverified"
	got := RunTrace(deadlineCtx(t, 10*time.Second), plan, fake)
	if len(fake.Calls) != 60 || got.Stop != TraceStopMaxHops || got.Details.DestinationReached {
		t.Fatalf("calls=%d %#v", len(fake.Calls), got.Stop)
	}
	if !got.Truncated || got.Details.HopsOmitted == 0 || len(got.Details.Hops)+got.Details.HopsOmitted != 60 {
		t.Fatalf("truncation not explicit: hops=%d omitted=%d", len(got.Details.Hops), got.Details.HopsOmitted)
	}
	encoded, _ := json.Marshal(Details{Trace: &got.Details})
	if len(encoded) > 8192 {
		t.Fatalf("details %d bytes exceed the 8 KiB step bound", len(encoded))
	}
}

// ---------------------------------------------------------------------------
// The trace step inside the durable M1 executor.
// ---------------------------------------------------------------------------

const (
	traceTargetID = "10000000-0000-4000-8000-000000000021"
	traceRouteID  = "10000000-0000-4000-8000-000000000022"
	traceStepID   = "10000000-0000-4000-8000-000000000023"
	traceDNSID    = "10000000-0000-4000-8000-000000000024"
	traceResolver = "10000000-0000-4000-8000-000000000025"
)

func sealCommand(t *testing.T, plan Plan) Command {
	t.Helper()
	plan.Digest = ""
	raw, e := json.Marshal(plan)
	if e != nil {
		t.Fatal(e)
	}
	canonical, e := canonicalPlan(raw)
	if e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256(canonical)
	plan.Digest = hex.EncodeToString(sum[:])
	return Command{Type: "network_diagnostic", Version: 1, CommandID: deviceID, RunID: siteID, AttemptID: orgID, Plan: plan, PlanDigest: plan.Digest, ExpiresAt: plan.Deadline}
}

func traceCommand(t *testing.T, mutate func(*Plan)) Command {
	t.Helper()
	now := time.Now().UTC()
	plan := Plan{Version: 1, RecipeID: "trace_route", RecipeVersion: 1, Scope: Scope{orgID, siteID},
		Origin: Origin{DeviceID: deviceID, AgentID: "agent", SiteID: siteID, ContextKey: "ctx", InterfaceID: ptr(deviceID), InterfaceEpoch: ptr("e"), InterfaceKey: ptr("if1"), ProducerEpoch: "epoch"},
		Family: "ipv4", AcceptedAt: now, QueueDeadline: now.Add(30 * time.Second), Deadline: now.Add(120 * time.Second), Limits: Limits{2, 4, 2, 30, 60, 120},
		Destinations: []Destination{{ID: traceTargetID, Target: Target{Kind: "configured_target", Definition: &TargetDefinition{Kind: "tcp", Enabled: true, Host: "192.0.2.3", Port: 443}}}},
		Steps: []PlanStep{
			{ID: traceRouteID, Required: true, Method: "route_lookup", DestinationID: ptr(traceTargetID)},
			{ID: traceStepID, Required: true, Method: "trace", DestinationID: ptr(traceTargetID), MaxHops: 16, ProbesPerHop: 1, HopTimeoutMS: 1000},
		}}
	if mutate != nil {
		mutate(&plan)
	}
	return sealCommand(t, plan)
}

type traceIO struct {
	fakeProbe
	transport   *fakeTraceTransport
	routes      []networkcontext.RouteSelection
	routeCalls  int
	resolved    []netip.Addr
	noTransport bool
}

func (f *traceIO) LookupRoute(_ context.Context, _ networkcontext.RouteLookupRequest) (networkcontext.RouteSelection, error) {
	route := networkcontext.RouteSelection{InterfaceKey: "if1", ContextKey: "ctx", SourceAddress: "192.0.2.10", NextHop: ptr("192.0.2.1"), Attribution: "observed", OSIndex: 7}
	if f.routeCalls < len(f.routes) {
		route = f.routes[f.routeCalls]
	}
	f.routeCalls++
	return route, nil
}
func (f *traceIO) Resolve(context.Context, string, string, []networkcontext.ResolverRow, networkcontext.RouteSelection, int) (DNSResolution, error) {
	f.resolveCalls++
	route, _ := f.LookupRoute(context.Background(), networkcontext.RouteLookupRequest{})
	f.routeCalls--
	return DNSResolution{Addresses: f.resolved, Resolver: networkcontext.ResolverRow{Address: "192.0.2.53", Port: 53}, Route: route}, nil
}
func (f *traceIO) TraceTransport() (TraceTransport, error) {
	if f.noTransport {
		return nil, ErrTraceUnsupported
	}
	return f.transport, nil
}

func traceRun(t *testing.T, command Command, replies map[int]TraceReply) (*Journal, *traceIO) {
	t.Helper()
	journal, e := OpenJournal(filepath.Join(t.TempDir(), "journal"))
	if e != nil {
		t.Fatal(e)
	}
	return journal, &traceIO{fakeProbe: fakeProbe{journal: journal, command: command}, transport: newFakeTraceTransport(replies)}
}

func stepByID(result Result, id string) StepResult {
	for _, step := range result.Steps {
		if step.ID == id {
			return step
		}
	}
	return StepResult{}
}

func TestDiagnosticTraceRunsThroughTheJournalExactlyOnce(t *testing.T) {
	command := traceCommand(t, nil)
	journal, io := traceRun(t, command, map[int]TraceReply{1: reply("192.0.2.1"), 3: reply("192.0.2.3")})
	result := Run(context.Background(), command, journal, io)
	step := stepByID(result, traceStepID)
	if step.State != "succeeded" || step.Details.Trace == nil || len(step.Details.Trace.Hops) != 3 || step.Details.Trace.Protocol != "icmp_echo" {
		t.Fatalf("trace step: %#v", step)
	}
	if step.Attribution.RequestedMethod != "trace" || step.Attribution.ActualMethod == nil || *step.Attribution.ActualMethod != "trace" || step.Attribution.ResolvedIP == nil || *step.Attribution.ResolvedIP != "192.0.2.3" || step.Attribution.LocalAddress == nil {
		t.Fatalf("attribution: %#v", step.Attribution)
	}
	if call := io.transport.Calls[0]; call.Source.Address != netip.MustParseAddr("192.0.2.10") || call.Source.InterfaceKey != "if1" || call.Source.OSIndex != 7 || call.Source.ContextKey != "ctx" {
		t.Fatalf("source binding not pinned: %#v", call.Source)
	}
	probes := len(io.transport.Calls)
	again := Run(context.Background(), command, journal, io)
	if len(io.transport.Calls) != probes || stepByID(again, traceStepID).State != "succeeded" {
		t.Fatalf("duplicate delivery re-probed: %d -> %d", probes, len(io.transport.Calls))
	}
}

func TestDiagnosticTraceUnreachedDestinationIsNotSuccess(t *testing.T) {
	command := traceCommand(t, func(p *Plan) { p.Steps[1].MaxHops = 3 })
	journal, io := traceRun(t, command, map[int]TraceReply{1: reply("192.0.2.1")})
	step := stepByID(Run(context.Background(), command, journal, io), traceStepID)
	if step.State != "failed_check" || step.Reason == nil || *step.Reason != "trace_destination_not_reached" || len(step.Details.Trace.Hops) != 3 {
		t.Fatalf("unreached: %#v", step)
	}
}

func TestDiagnosticTraceUnsupportedPlatformIsExplicit(t *testing.T) {
	command := traceCommand(t, nil)
	journal, io := traceRun(t, command, nil)
	io.noTransport = true
	step := stepByID(Run(context.Background(), command, journal, io), traceStepID)
	if step.State != "unsupported" || step.Reason == nil || *step.Reason != "trace_unsupported" || len(io.transport.Calls) != 0 {
		t.Fatalf("unsupported: %#v", step)
	}
}

func TestDiagnosticTraceCancelledBeforeStepStartNeverProbes(t *testing.T) {
	command := traceCommand(t, nil)
	journal, io := traceRun(t, command, map[int]TraceReply{1: reply("192.0.2.3")})
	if e := journal.Cancel(command.CommandID, command.RunID, command.AttemptID); e != nil {
		t.Fatal(e)
	}
	result := Run(context.Background(), command, journal, io)
	if len(io.transport.Calls) != 0 || stepByID(result, traceStepID).State != "cancelled" {
		t.Fatalf("cancelled run probed: %#v", result)
	}
}

func TestDiagnosticTraceCancelledAfterStepStartKeepsPartialHops(t *testing.T) {
	command := traceCommand(t, nil)
	journal, io := traceRun(t, command, map[int]TraceReply{1: reply("192.0.2.1"), 2: reply("192.0.2.2")})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	io.transport.onProbe = func(ttl, _ int) {
		if ttl == 3 {
			if _, started := journal.Result(command.StepKey(traceStepID)); !started {
				panic("trace probe before its journal intent")
			}
			_ = journal.Cancel(command.CommandID, command.RunID, command.AttemptID)
			cancel()
		}
	}
	step := stepByID(Run(ctx, command, journal, io), traceStepID)
	if step.State != "cancelled" || step.Details.Trace == nil || len(step.Details.Trace.Hops) != 2 {
		t.Fatalf("mid-trace cancel: %#v", step)
	}
	if stored, ok := journal.Result(command.StepKey(traceStepID)); !ok || stored == nil || stored.State != "cancelled" {
		t.Fatalf("cancelled outcome not journaled: %#v", stored)
	}
}

func TestDiagnosticTracePlanBoundsAreEnforcedByTheAgent(t *testing.T) {
	now := time.Now()
	for name, mutate := range map[string]func(*Plan){
		"31 hops":              func(p *Plan) { p.Steps[1].MaxHops = 31 },
		"3 probes":             func(p *Plan) { p.Steps[1].ProbesPerHop = 3 },
		"slow hops":            func(p *Plan) { p.Steps[1].HopTimeoutMS = 1001 },
		"no hops":              func(p *Plan) { p.Steps[1].MaxHops = 0 },
		"90s execution":        func(p *Plan) { p.Limits.ExecutionTimeoutSeconds = 90 },
		"trace outside recipe": func(p *Plan) { p.RecipeID = "gateway_basic" },
		"tcp inside trace":     func(p *Plan) { p.Steps[0].Method = "tcp"; p.Steps[0].TimeoutMS = 1000 },
	} {
		command := traceCommand(t, mutate)
		if e := ValidateCommand(command, now); e == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	if e := ValidateCommand(traceCommand(t, nil), now); e != nil {
		t.Fatalf("valid trace rejected: %v", e)
	}
}

func TestDiagnosticTraceLinkLocalZoneMustMatchTheRoute(t *testing.T) {
	command := traceCommand(t, func(p *Plan) {
		p.Family = "ipv6"
		p.Destinations = []Destination{{ID: traceTargetID, Target: Target{Kind: "observed_gateway", Address: "fe80::1", Zone: ptr("if-other"), InterfaceID: deviceID, EvidenceID: deviceID}}}
		p.Steps = p.Steps[1:]
	})
	journal, io := traceRun(t, command, map[int]TraceReply{1: reply("fe80::1")})
	io.routes = []networkcontext.RouteSelection{{InterfaceKey: "if1", ContextKey: "ctx", SourceAddress: "fe80::10", NextHop: ptr("fe80::1"), Attribution: "observed", OSIndex: 7}}
	step := stepByID(Run(context.Background(), command, journal, io), traceStepID)
	if len(io.transport.Calls) != 0 || step.State != "execution_error" || *step.Reason != "destination_blocked" {
		t.Fatalf("zone mismatch probed: %#v", step)
	}
}

func TestDiagnosticTraceRouteSwitchDowngradesHopAttribution(t *testing.T) {
	command := traceCommand(t, nil)
	journal, io := traceRun(t, command, map[int]TraceReply{1: reply("192.0.2.3")})
	io.routes = []networkcontext.RouteSelection{
		{InterfaceKey: "if1", ContextKey: "ctx", SourceAddress: "192.0.2.10", NextHop: ptr("192.0.2.1"), Attribution: "observed", OSIndex: 7},
		{InterfaceKey: "if1", ContextKey: "ctx", SourceAddress: "192.0.2.11", NextHop: ptr("192.0.2.254"), Attribution: "observed", OSIndex: 7},
	}
	step := stepByID(Run(context.Background(), command, journal, io), traceStepID)
	if !step.Attribution.RouteChanged || step.Attribution.Quality != "requested_unverified" || step.Details.Trace.Hops[0].AttributionQuality != "requested_unverified" {
		t.Fatalf("route switch hidden: %#v", step)
	}
}

func TestDiagnosticTraceUsesThePinnedResolutionNotANewLookup(t *testing.T) {
	command := traceCommand(t, func(p *Plan) {
		p.Destinations = []Destination{
			{ID: traceTargetID, Target: Target{Kind: "configured_target", Definition: &TargetDefinition{Kind: "tcp", Enabled: true, Host: "status.example.test", Port: 443}}},
			{ID: traceResolver, Target: Target{Kind: "observed_resolver", Address: "192.0.2.53", Port: 53}},
		}
		p.Steps = append([]PlanStep{{ID: traceDNSID, Required: true, Method: "dns", DestinationID: ptr(traceTargetID), TimeoutMS: 2000, QueryType: "A", ResolverDestinationIDs: []string{traceResolver}}}, p.Steps...)
	})
	journal, io := traceRun(t, command, map[int]TraceReply{1: reply("192.0.2.20")})
	io.resolved = []netip.Addr{netip.MustParseAddr("192.0.2.20")}
	result := Run(context.Background(), command, journal, io)
	if io.resolveCalls != 1 || len(io.transport.Calls) != 1 || io.transport.Calls[0].Destination != netip.MustParseAddr("192.0.2.20") {
		t.Fatalf("trace re-resolved or left the pinned literal: resolves=%d calls=%#v", io.resolveCalls, io.transport.Calls)
	}
	if step := stepByID(result, traceStepID); step.State != "succeeded" {
		t.Fatalf("pinned trace: %#v", step)
	}
	// A rebinding answer to a blocked address never reaches the transport.
	command2 := traceCommand(t, func(p *Plan) { *p = command.Plan; p.Digest = "" })
	journal2, io2 := traceRun(t, command2, nil)
	io2.resolved = []netip.Addr{netip.MustParseAddr("169.254.169.254")}
	Run(context.Background(), command2, journal2, io2)
	if len(io2.transport.Calls) != 0 {
		t.Fatal("rebinding answer was traced")
	}
}

func TestDiagnosticTraceVectorDecodesStrictly(t *testing.T) {
	b, e := os.ReadFile("../../../packages/shared/src/testing/topology-diagnostic-vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var data struct {
		Vectors []struct {
			Name string          `json:"name"`
			Plan json.RawMessage `json:"plan"`
		}
	}
	if e = json.Unmarshal(b, &data); e != nil {
		t.Fatal(e)
	}
	found := false
	for _, v := range data.Vectors {
		if v.Name != "trace-route" {
			continue
		}
		found = true
		var plan struct {
			Digest   string `json:"digest"`
			Deadline string `json:"deadline"`
		}
		_ = json.Unmarshal(v.Plan, &plan)
		raw := []byte(`{"type":"network_diagnostic","version":1,"runId":"` + siteID + `","attemptId":"` + orgID + `","commandId":"` + deviceID + `","plan":` + string(v.Plan) + `,"planDigest":"` + plan.Digest + `","expiresAt":"` + plan.Deadline + `"}`)
		command, e := DecodeCommand(raw)
		if e != nil {
			t.Fatalf("trace vector rejected by strict decode: %v", e)
		}
		if command.Plan.Steps[1].Method != "trace" || command.Plan.Steps[1].ProbesPerHop != 2 || command.Plan.Steps[1].HopTimeoutMS != 1000 {
			t.Fatalf("trace fields lost: %#v", command.Plan.Steps[1])
		}
		accepted, _ := time.Parse(time.RFC3339, "2026-09-15T12:00:01Z")
		if e = ValidateCommand(command, accepted); e != nil {
			t.Fatalf("server-sealed trace plan rejected: %v", e)
		}
	}
	if !found {
		t.Fatal("no trace-route vector")
	}
}
