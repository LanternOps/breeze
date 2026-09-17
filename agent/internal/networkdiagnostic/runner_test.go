package networkdiagnostic

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"net/netip"
	"path/filepath"
	"testing"
	"time"
)

const (
	deviceID   = "10000000-0000-4000-8000-000000000001"
	siteID     = "10000000-0000-4000-8000-000000000002"
	orgID      = "10000000-0000-4000-8000-000000000003"
	targetID   = "10000000-0000-4000-8000-000000000004"
	resolverID = "10000000-0000-4000-8000-000000000005"
	dnsStepID  = "10000000-0000-4000-8000-000000000006"
	httpStepID = "10000000-0000-4000-8000-000000000007"
)

func testCommand(t *testing.T) Command {
	t.Helper()
	now := time.Now().UTC()
	plan := Plan{Version: 1, RecipeID: "internet_basic", RecipeVersion: 1, Scope: Scope{orgID, siteID}, Origin: Origin{DeviceID: deviceID, AgentID: "agent", SiteID: siteID, ContextKey: "ctx", InterfaceID: ptr(deviceID), InterfaceEpoch: ptr("e"), InterfaceKey: ptr("if1"), ProducerEpoch: "epoch"}, Family: "ipv4", AcceptedAt: now, QueueDeadline: now.Add(30 * time.Second), Deadline: now.Add(120 * time.Second), Limits: Limits{2, 4, 2, 30, 90, 120}, Destinations: []Destination{{ID: targetID, Target: Target{Kind: "configured_target", Definition: &TargetDefinition{Kind: "https", Enabled: true, Hostname: "status.example.test", Port: 443, Path: "/health", Method: "GET", ExpectedStatus: 200, ProxyMode: "direct"}}}, {ID: resolverID, Target: Target{Kind: "observed_resolver", Address: "192.0.2.53", Port: 53}}}, Steps: []PlanStep{{ID: dnsStepID, Method: "dns", DestinationID: ptr(targetID), TimeoutMS: 2000, QueryType: "A", ResolverDestinationIDs: []string{resolverID}}, {ID: httpStepID, Method: "http", DestinationID: ptr(targetID), TimeoutMS: 5000, ResponseLimitBytes: 65536}}}
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

type fakeProbe struct {
	answers                           []netip.Addr
	resolveCalls, httpCalls, tcpCalls int
	dialed                            netip.Addr
	serverName                        string
	journal                           *Journal
	command                           Command
	onResolve                         func()
}

func (f *fakeProbe) LookupRoute(_ context.Context, r networkcontext.RouteLookupRequest) (networkcontext.RouteSelection, error) {
	return networkcontext.RouteSelection{InterfaceKey: "if1", ContextKey: "ctx", SourceAddress: "192.0.2.10", NextHop: ptr("192.0.2.1"), Attribution: "observed"}, nil
}
func (f *fakeProbe) Resolvers(context.Context) ([]networkcontext.ResolverRow, error) {
	return []networkcontext.ResolverRow{{Address: "192.0.2.53", Port: 53, InterfaceKey: ptr("if1")}}, nil
}
func (f *fakeProbe) Resolve(context.Context, string, string, []networkcontext.ResolverRow, networkcontext.RouteSelection, int) (DNSResolution, error) {
	f.resolveCalls++
	if f.onResolve != nil {
		f.onResolve()
	}
	if _, exists := f.journal.Result(f.command.StepKey(dnsStepID)); !exists {
		panic("DNS before intent")
	}
	route, _ := f.LookupRoute(context.Background(), networkcontext.RouteLookupRequest{})
	return DNSResolution{Addresses: f.answers, Resolver: networkcontext.ResolverRow{Address: "192.0.2.53", Port: 53}, Route: route}, nil
}
func (f *fakeProbe) ICMP(context.Context, netip.Addr, networkcontext.RouteSelection, int, int) (Details, error) {
	return Details{}, nil
}
func (f *fakeProbe) TCP(context.Context, netip.Addr, uint16, networkcontext.RouteSelection) (Details, error) {
	f.tcpCalls++
	return Details{}, nil
}
func (f *fakeProbe) HTTPS(_ context.Context, ip netip.Addr, target TargetDefinition, _ networkcontext.RouteSelection, _ string, _ int) (Details, error) {
	if _, exists := f.journal.Result(f.command.StepKey(httpStepID)); !exists {
		panic("HTTP before intent")
	}
	f.httpCalls++
	f.dialed = ip
	f.serverName = target.Hostname
	return Details{StatusCode: ptr(200)}, nil
}
func fakeRun(t *testing.T, answers ...string) (Command, *Journal, *fakeProbe) {
	t.Helper()
	command := testCommand(t)
	journal, e := OpenJournal(filepath.Join(t.TempDir(), "journal"))
	if e != nil {
		t.Fatal(e)
	}
	fake := &fakeProbe{journal: journal, command: command}
	for _, ip := range answers {
		fake.answers = append(fake.answers, netip.MustParseAddr(ip))
	}
	return command, journal, fake
}
func TestHTTPPinsValidatedAddressAndJournalsEverySideEffect(t *testing.T) {
	command, journal, io := fakeRun(t, "192.0.2.20")
	result := Run(context.Background(), command, journal, io)
	if io.resolveCalls != 1 || io.httpCalls != 1 || io.dialed.String() != "192.0.2.20" || io.serverName != "status.example.test" {
		t.Fatal(io, result)
	}
	if result.Steps[1].State != "succeeded" || *result.Steps[1].Attribution.ActualMethod != "http" {
		t.Fatal(result)
	}
	if got := result.Steps[0].Attribution; got.Quality != "observed" || got.ResolvedIP == nil || *got.ResolvedIP != "192.0.2.53" || got.LocalAddress == nil || got.Port == nil || *got.Port != 53 || got.Family == nil {
		t.Fatal(got)
	}
	again := Run(context.Background(), command, journal, io)
	if io.resolveCalls != 1 || io.httpCalls != 1 || again.Steps[1].State != "succeeded" {
		t.Fatal("duplicate network call", again)
	}
}
func TestMixedDNSAnswersCannotProbeMetadata(t *testing.T) {
	c, j, io := fakeRun(t, "192.0.2.20", "169.254.169.254")
	result := Run(context.Background(), c, j, io)
	if io.httpCalls != 0 || result.Steps[0].State != "execution_error" {
		t.Fatal(result, io)
	}
}
func TestDigestTamperingAndExpiryStartNoProbes(t *testing.T) {
	for _, mutate := range []func(*Command){func(c *Command) { c.Plan.Destinations[0].Target.Definition.Hostname = "attacker.example.test" }, func(c *Command) { c.ExpiresAt = time.Now().Add(-time.Minute) }} {
		c, j, io := fakeRun(t, "192.0.2.20")
		mutate(&c)
		Run(context.Background(), c, j, io)
		if io.resolveCalls != 0 || io.httpCalls != 0 {
			t.Fatal("invalid plan probed")
		}
	}
}
func TestCancellationPersistsTerminalSteps(t *testing.T) {
	c, j, io := fakeRun(t, "192.0.2.20")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := Run(ctx, c, j, io)
	if result.Steps[0].State != "cancelled" {
		t.Fatal(result)
	}
	Run(context.Background(), c, j, io)
	if io.resolveCalls != 0 || io.httpCalls != 0 {
		t.Fatal("cancelled replay probed")
	}
}

// A journal that refuses to open a step because the run was cancelled or has
// already expired is a real, known outcome — not an unavailable journal.
func TestStartStepRefusalKeepsItsOwnTerminalState(t *testing.T) {
	for _, tc := range []struct {
		name          string
		interrupt     func(*Journal, Command)
		state, reason string
	}{
		{
			name:      "cancelled",
			interrupt: func(j *Journal, c Command) { _ = j.Cancel(c.CommandID, c.RunID, c.AttemptID) },
			state:     "cancelled", reason: "cancelled",
		},
		{
			name: "expired",
			interrupt: func(j *Journal, c Command) {
				j.clock = func() time.Time { return c.ExpiresAt.Add(time.Second) }
			},
			state: "timeout", reason: "execution_deadline",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, j, io := fakeRun(t, "192.0.2.20")
			io.onResolve = func() { tc.interrupt(j, c) }
			result := Run(context.Background(), c, j, io)
			if len(result.Steps) != 2 {
				t.Fatalf("expected both steps, got %v", result.Steps)
			}
			step := result.Steps[1]
			if step.State != tc.state || step.Reason == nil || *step.Reason != tc.reason {
				t.Fatalf("got %s/%v want %s/%s", step.State, step.Reason, tc.state, tc.reason)
			}
			if io.httpCalls != 0 {
				t.Fatal("refused step still probed")
			}
		})
	}
}
