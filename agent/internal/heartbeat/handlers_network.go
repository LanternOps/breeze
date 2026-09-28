package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/config"

	"github.com/breeze-rmm/agent/internal/discovery"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/snmppoll"
)

func init() {
	handlerRegistry[tools.CmdNetworkDiscovery] = handleNetworkDiscovery
	handlerRegistry[tools.CmdSnmpPoll] = handleSnmpPoll
}

// collectDiscoveryPhysical is the physical-collection seam (stubbed in tests).
var collectDiscoveryPhysical = func(s *discovery.Scanner, ctx context.Context, hosts []discovery.DiscoveredHost, protocols []string, contextKey string) []discovery.TargetPhysical {
	return s.CollectPhysicalFor(ctx, hosts, protocols, contextKey)
}

// Legacy `adjacency` bounds in the final command result. Hosts go first and are
// never dropped for adjacency: the whole result is replaced wholesale above the
// 5,000,000-byte limit (wire.MaxCommandResultBytes), so adjacency is capped
// on its own — FDB trimmed first — and flagged with adjacencyTruncated.
const (
	legacyAdjacencyRowsPerTarget = 2000
	legacyAdjacencyMaxBytes      = 1 << 20
)

func handleNetworkDiscovery(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	scanConfig := discovery.ScanConfig{
		Subnets:          tools.GetPayloadStringSlice(cmd.Payload, "subnets"),
		ExcludeIPs:       tools.GetPayloadStringSlice(cmd.Payload, "excludeIps"),
		Methods:          tools.GetPayloadStringSlice(cmd.Payload, "methods"),
		PortRanges:       tools.GetPayloadStringSlice(cmd.Payload, "portRanges"),
		SNMPCommunities:  tools.GetPayloadStringSlice(cmd.Payload, "snmpCommunities"),
		SNMPCredentials:  parseDiscoverySNMPCredentials(cmd.Payload),
		Timeout:          time.Duration(tools.GetPayloadInt(cmd.Payload, "timeout", 2)) * time.Second,
		Concurrency:      tools.GetPayloadInt(cmd.Payload, "concurrency", 128),
		DeepScan:         tools.GetPayloadBool(cmd.Payload, "deepScan", false),
		IdentifyOS:       tools.GetPayloadBool(cmd.Payload, "identifyOS", false),
		ResolveHostnames: tools.GetPayloadBool(cmd.Payload, "resolveHostnames", false),
	}
	scanner := discovery.NewScanner(scanConfig)
	targetCount, err := scanner.TargetCount()
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	hosts, err := scanner.Scan()
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	jobID := tools.GetPayloadString(cmd.Payload, "jobId", "")

	// Adjacency v2 only when the parent command advertises it; the collection
	// is scoped to the dispatch's requested protocols/context.
	dispatch, v2 := discovery.ParseAdjacencyDispatch(cmd.Payload["topology"])
	protocols := []string{discovery.SectionLLDP, discovery.SectionCDP, discovery.SectionFDB, discovery.SectionInterfaces}
	contextKey := "default"
	if v2 {
		protocols, contextKey = dispatch.Protocols, dispatch.Contexts[0]
	}
	physical := collectDiscoveryPhysical(scanner, context.Background(), hosts, protocols, contextKey)

	legacy := make([]discovery.DeviceAdjacency, 0, len(physical))
	for _, t := range physical {
		adj := discovery.LegacyAdjacencyFromSections(t.Target, t.Sections)
		if len(adj.Lldp) > 0 || len(adj.Cdp) > 0 || len(adj.Fdb) > 0 {
			legacy = append(legacy, adj)
		}
	}
	if v2 && h != nil && jobID != "" && len(physical) > 0 {
		postAdjacencyV2(h, dispatch, jobID, cmd.ID, physical)
	}
	adjacency, truncated := boundLegacyAdjacency(legacy)
	result := map[string]any{
		"jobId":           jobID,
		"hosts":           hosts,
		"hostsScanned":    targetCount,
		"hostsDiscovered": len(hosts),
		"adjacency":       adjacency,
	}
	if truncated {
		result["adjacencyTruncated"] = true
	}
	return tools.NewSuccessResult(result, time.Since(start).Milliseconds())
}

// postAdjacencyV2 sends one report per target before the dispatch deadline.
func postAdjacencyV2(h *Heartbeat, dispatch discovery.AdjacencyDispatch, jobID, commandID string, physical []discovery.TargetPhysical) {
	path := h.adjacencyStatePath
	if path == "" {
		path = filepath.Join(config.GetDataDir(), "topology-adjacency-state.json")
	}
	ctx, cancel := context.WithDeadline(context.Background(), dispatch.Deadline)
	defer cancel()
	transport := &discovery.AdjacencyTransport{
		Dispatch: dispatch, ParentJobID: jobID, ParentCommandID: commandID, State: discovery.OpenAdjacencyState(path),
		Poster: &discovery.HTTPAdjacencyPoster{Client: h.httpClient(), Authorization: h.authHeader(), Retry: h.retryCfg,
			URL: fmt.Sprintf("%s/api/v1/agents/%s/topology/adjacency", h.serverURL(), h.config.AgentID)},
	}
	accepted := 0
	outcomes := transport.Send(ctx, physical)
	for _, o := range outcomes {
		if o.Accepted {
			accepted++
		}
	}
	slog.Info("adjacency v2 reports posted", "jobId", jobID, "targets", len(outcomes), "accepted", accepted)
}

// boundLegacyAdjacency caps rows per target (FDB trimmed before CDP/LLDP) and
// the total encoded size, reporting whether anything was dropped.
func boundLegacyAdjacency(in []discovery.DeviceAdjacency) ([]discovery.DeviceAdjacency, bool) {
	truncated := false
	out := make([]discovery.DeviceAdjacency, 0, len(in))
	for _, a := range in {
		budget := legacyAdjacencyRowsPerTarget
		keep := func(n int) int {
			if n > budget {
				truncated = true
				n = budget
			}
			budget -= n
			return n
		}
		a.Lldp = a.Lldp[:keep(len(a.Lldp))]
		a.Cdp = a.Cdp[:keep(len(a.Cdp))]
		a.Fdb = a.Fdb[:keep(len(a.Fdb))]
		out = append(out, a)
	}
	for {
		b, err := json.Marshal(out)
		if err != nil || len(b) <= legacyAdjacencyMaxBytes {
			return out, truncated
		}
		truncated = true
		// Trim the largest target's FDB first, then drop whole trailing targets.
		largest := -1
		for i := range out {
			if len(out[i].Fdb) > 0 && (largest < 0 || len(out[i].Fdb) > len(out[largest].Fdb)) {
				largest = i
			}
		}
		if largest >= 0 {
			out[largest].Fdb = out[largest].Fdb[:len(out[largest].Fdb)/2]
			continue
		}
		out = out[:len(out)-1]
	}
}

// parseDiscoverySNMPCredentials reads the profile's `snmpCredentials` from a
// network_discovery payload. The server sends the decrypted object
// (version/username/authProtocol/authPassphrase/privacyProtocol/
// privacyPassphrase/port/timeout/retries — see discoveryWorker.ts); an array
// of such objects is accepted too. Before issue #6234 this field was never
// read, so a v3 profile went on the wire as v2c/"public".
//
// The credential's `timeout` is milliseconds (profile SNMP settings), unlike
// the scan-level `timeout`, which is seconds.
func parseDiscoverySNMPCredentials(payload map[string]any) []discovery.SNMPCredential {
	raw, ok := payload["snmpCredentials"]
	if !ok || raw == nil {
		return nil
	}
	var entries []map[string]any
	switch v := raw.(type) {
	case map[string]any:
		entries = []map[string]any{v}
	case []any:
		for _, item := range v {
			if obj, ok := item.(map[string]any); ok {
				entries = append(entries, obj)
			}
		}
	default:
		return nil
	}

	out := make([]discovery.SNMPCredential, 0, len(entries))
	for _, entry := range entries {
		cred := discovery.SNMPCredential{
			Version:        tools.GetPayloadString(entry, "version", "v2c"),
			Community:      tools.GetPayloadString(entry, "community", ""),
			Username:       tools.GetPayloadString(entry, "username", ""),
			AuthProtocol:   tools.GetPayloadString(entry, "authProtocol", ""),
			AuthPassphrase: firstPayloadString(entry, "authPassphrase", "authPassword"),
			PrivProtocol:   firstPayloadString(entry, "privacyProtocol", "privProtocol"),
			PrivPassphrase: firstPayloadString(entry, "privacyPassphrase", "privPassword"),
			Port:           tools.GetPayloadInt(entry, "port", 0),
			Retries:        tools.GetPayloadInt(entry, "retries", 0),
		}
		if ms := tools.GetPayloadInt(entry, "timeout", 0); ms > 0 {
			cred.Timeout = time.Duration(ms) * time.Millisecond
		}
		// Incomplete entries are kept: discovery.ResolveSNMPCredentials is the
		// one place that decides usability and logs why an entry was skipped.
		out = append(out, cred)
	}
	return out
}

func firstPayloadString(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		if v := tools.GetPayloadString(payload, key, ""); v != "" {
			return v
		}
	}
	return ""
}

// parseSnmpPollRequest turns a poll command payload into an SNMPDevice.
//
// Split out of handleSnmpPoll so the wire contract (spec §7.1) is unit-testable
// without a network: every branch below decides what the agent will put on the
// wire, and that is exactly the part an SNMP device cannot be asked about.
func parseSnmpPollRequest(payload map[string]any) (snmppoll.SNMPDevice, *tools.CommandResult) {
	target, errResult := tools.RequirePayloadString(payload, "target")
	if errResult != nil {
		return snmppoll.SNMPDevice{}, errResult
	}

	var snmpVersion snmppoll.SNMPVersion
	switch tools.GetPayloadString(payload, "version", "v2c") {
	case "v1", "1":
		snmpVersion = snmppoll.Version1
	case "v3", "3":
		snmpVersion = snmppoll.Version3
	default:
		snmpVersion = snmppoll.Version2c
	}

	// The port narrows to uint16 below; an out-of-range value would silently
	// wrap onto some other port, so reject it instead of probing the wrong one.
	port := tools.GetPayloadInt(payload, "port", 161)
	if port < 1 || port > 65535 {
		result := tools.NewErrorResult(fmt.Errorf("port must be 1-65535, got %d", port), 0)
		return snmppoll.SNMPDevice{}, &result
	}

	oids := tools.GetPayloadStringSlice(payload, "oids")

	return snmppoll.SNMPDevice{
		IP:      target,
		Port:    uint16(port),
		Version: snmpVersion,
		Auth: snmppoll.SNMPAuth{
			Community:      tools.GetPayloadString(payload, "community", "public"),
			Username:       tools.GetPayloadString(payload, "username", ""),
			AuthProtocol:   snmppoll.ParseAuthProtocol(tools.GetPayloadString(payload, "authProtocol", "")),
			AuthPassphrase: tools.GetPayloadString(payload, "authPassword", ""),
			PrivProtocol:   snmppoll.ParsePrivProtocol(tools.GetPayloadString(payload, "privProtocol", "")),
			PrivPassphrase: tools.GetPayloadString(payload, "privPassword", ""),
		},
		OIDs:    oids,
		Specs:   parseOIDSpecs(payload, oids),
		Limits:  parsePollLimits(payload),
		Timeout: time.Duration(tools.GetPayloadInt(payload, "timeout", 2)) * time.Second,
		Retries: tools.GetPayloadInt(payload, "retries", 1),
	}, nil
}

// parseOIDSpecs reads `oidSpecs`, falling back to the legacy `oids` as plain
// GETs. The fallback is the compatibility contract in both directions: a
// pre-W02 server sends no specs and gets exactly today's behaviour.
func parseOIDSpecs(payload map[string]any, legacyOIDs []string) []snmppoll.OIDSpec {
	raw := tools.GetPayloadObjectSlice(payload, "oidSpecs")
	specs := make([]snmppoll.OIDSpec, 0, len(raw))
	dropped := 0
	for _, entry := range raw {
		oid := strings.TrimSpace(tools.GetPayloadString(entry, "oid", ""))
		if oid == "" {
			dropped++
			continue
		}
		name := tools.GetPayloadString(entry, "name", "")
		if name == "" {
			name = oid
		}
		mode := tools.GetPayloadString(entry, "mode", "")
		if mode != snmppoll.ModeGet && mode != snmppoll.ModeWalk {
			mode = snmppoll.DefaultMode(oid)
		}
		cadence := tools.GetPayloadString(entry, "cadence", "")
		if cadence != snmppoll.CadenceFast && cadence != snmppoll.CadenceSlow {
			cadence = snmppoll.CadenceFast
		}
		specs = append(specs, snmppoll.OIDSpec{OID: oid, Name: name, Mode: mode, Cadence: cadence})
	}
	if dropped > 0 {
		slog.Warn("snmp_poll: dropped malformed oidSpecs entries", "dropped", dropped)
	}
	if len(specs) > 0 {
		return specs
	}
	if value, present := payload["oidSpecs"]; present {
		entries, _ := value.([]any)
		slog.Warn("snmp_poll: oidSpecs present but unusable; falling back to legacy GETs", "rawLen", len(entries), "legacyOids", legacyOIDs)
	}
	return snmppoll.SpecsFromOIDs(legacyOIDs)
}

// parsePollLimits reads `limits`, keeping the compiled-in default for any bound
// the server omitted or sent as a non-positive value. A zero row bound means
// "collect nothing" and a negative duration means "already expired"; both would
// silently stop collection, so neither is honoured.
func parsePollLimits(payload map[string]any) snmppoll.PollLimits {
	limits := snmppoll.DefaultPollLimits
	raw := tools.GetPayloadObject(payload, "limits")
	if raw == nil {
		return limits
	}
	if v := tools.GetPayloadInt(raw, "maxRowsPerOid", 0); v > 0 {
		limits.MaxRowsPerOID = v
	}
	if v := tools.GetPayloadInt(raw, "maxRowsPerPoll", 0); v > 0 {
		limits.MaxRowsPerPoll = v
	}
	if v := tools.GetPayloadInt(raw, "maxBytesPerPoll", 0); v > 0 {
		limits.MaxBytesPerPoll = v
	}
	if v := tools.GetPayloadInt(raw, "maxDurationMs", 0); v > 0 {
		limits.MaxDuration = time.Duration(v) * time.Millisecond
	}
	return limits
}

// SnmpResultProtocol marks the metric row shape this agent emits (spec §7.2):
// every row carries baseOid, instance and an optional per-OID error. The server
// treats a result with NO protocol field as the legacy shape (baseOid = oid,
// instance = ""), so this must be stamped on every successful poll — including
// one built from a legacy oids-only command, whose rows already have that shape.
const SnmpResultProtocol = 2

func snmpPollResultPayload(deviceID string, metrics []snmppoll.SNMPMetric) map[string]any {
	return map[string]any{
		"deviceId": deviceID,
		"metrics":  metrics,
		"protocol": SnmpResultProtocol,
	}
}

func handleSnmpPoll(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	device, errResult := parseSnmpPollRequest(cmd.Payload)
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	metrics, err := snmppoll.CollectMetrics(device)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(
		snmpPollResultPayload(tools.GetPayloadString(cmd.Payload, "deviceId", ""), metrics),
		time.Since(start).Milliseconds(),
	)
}
