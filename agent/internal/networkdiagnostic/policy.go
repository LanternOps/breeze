package networkdiagnostic

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/netip"
	"regexp"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"github.com/google/uuid"
)

var ErrBlocked = errors.New("destination_blocked")
var ErrUnsupportedContext = errors.New("unsupported_context")
var hostnamePattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$`)

func canonicalPlan(raw []byte) ([]byte, error) {
	var object map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if e := d.Decode(&object); e != nil {
		return nil, e
	}
	delete(object, "digest")
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	if e := encoder.Encode(object); e != nil {
		return nil, e
	}
	out := bytes.TrimSuffix(b.Bytes(), []byte("\n"))
	out = bytes.ReplaceAll(out, []byte(`\u2028`), []byte("\u2028"))
	out = bytes.ReplaceAll(out, []byte(`\u2029`), []byte("\u2029"))
	return out, nil
}
func DecodeCommand(raw []byte) (Command, error) {
	if len(raw) > 128*1024 {
		return Command{}, errors.New("command_too_large")
	}
	var command Command
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(&command); e != nil {
		return Command{}, e
	}
	var extra any
	if e := d.Decode(&extra); e != io.EOF {
		return Command{}, errors.New("trailing_command_data")
	}
	var fields map[string]json.RawMessage
	if e := json.Unmarshal(raw, &fields); e != nil {
		return Command{}, e
	}
	command.rawPlan = append([]byte{}, fields["plan"]...)
	return command, nil
}
func ValidateCommand(command Command, now time.Time) error {
	p := command.Plan
	if command.Type != "network_diagnostic" || command.Version != 1 || p.Version != 1 || p.RecipeVersion != 1 {
		return errors.New("unsupported_version")
	}
	for _, id := range []string{command.CommandID, command.RunID, command.AttemptID, p.Origin.DeviceID, p.Origin.SiteID, p.Scope.SiteID, p.Scope.OrgID} {
		if _, e := uuid.Parse(id); e != nil {
			return errors.New("invalid_identity")
		}
	}
	if p.Origin.SiteID != p.Scope.SiteID || p.Origin.AgentID == "" || p.Origin.ContextKey == "" || p.Origin.ProducerEpoch == "" {
		return errors.New("invalid_origin")
	}
	if (p.Origin.InterfaceID == nil) != (p.Origin.InterfaceKey == nil) || (p.Origin.InterfaceID == nil) != (p.Origin.InterfaceEpoch == nil) {
		return errors.New("invalid_interface_binding")
	}
	if p.Family != "ipv4" && p.Family != "ipv6" {
		return errors.New("invalid_family")
	}
	switch p.RecipeID {
	case "gateway_basic", "dns_basic", "internet_basic", "target_connectivity":
	default:
		return errors.New("unsupported_recipe")
	}
	if len(p.Steps) > 12 || len(p.Destinations) > 8 || p.Limits.MaxConcurrentSteps < 1 || p.Limits.MaxConcurrentSteps > 2 || p.Limits.MaxTargetAddresses < 0 || p.Limits.MaxTargetAddresses > 4 || p.Limits.MaxResolvers < 0 || p.Limits.MaxResolvers > 2 {
		return errors.New("plan_limit_exceeded")
	}
	if p.Limits.QueueTimeoutSeconds < 1 || p.Limits.QueueTimeoutSeconds > 30 || p.Limits.ExecutionTimeoutSeconds < 1 || p.Limits.ExecutionTimeoutSeconds > 90 || p.Limits.LifetimeSeconds < 1 || p.Limits.LifetimeSeconds > 120 {
		return errors.New("invalid_deadline")
	}
	if !command.ExpiresAt.Equal(p.Deadline) || !p.Deadline.After(now) || !p.QueueDeadline.After(now) || !p.QueueDeadline.After(p.AcceptedAt) || p.QueueDeadline.Sub(p.AcceptedAt) > time.Duration(p.Limits.QueueTimeoutSeconds)*time.Second || p.Deadline.Sub(p.AcceptedAt) > time.Duration(p.Limits.LifetimeSeconds)*time.Second || p.AcceptedAt.After(now.Add(5*time.Second)) {
		return errors.New("expired")
	}
	raw := command.rawPlan
	if len(raw) == 0 {
		var e error
		raw, e = json.Marshal(p)
		if e != nil {
			return e
		}
	}
	canonical, e := canonicalPlan(raw)
	if e != nil {
		return e
	}
	hash := sha256.Sum256(canonical)
	if command.PlanDigest != p.Digest || command.PlanDigest != hex.EncodeToString(hash[:]) {
		return errors.New("plan_digest_mismatch")
	}
	destinations := map[string]Target{}
	for _, d := range p.Destinations {
		if _, e := uuid.Parse(d.ID); e != nil {
			return errors.New("invalid_destination")
		}
		if _, exists := destinations[d.ID]; exists {
			return errors.New("duplicate_destination")
		}
		destinations[d.ID] = d.Target
		switch d.Target.Kind {
		case "observed_gateway", "observed_resolver":
			if _, e := netip.ParseAddr(d.Target.Address); e != nil {
				return errors.New("invalid_address")
			}
			if d.Target.Kind == "observed_resolver" && d.Target.Port == 0 {
				return errors.New("invalid_port")
			}
		case "configured_target":
			definition := d.Target.Definition
			if definition == nil || !definition.Enabled {
				return errors.New("target_not_configured")
			}
			if definition.Kind == "https" {
				if definition.Port == 0 || !hostnamePattern.MatchString(definition.Hostname) || len(definition.Path) > 2048 || !strings.HasPrefix(definition.Path, "/") || strings.HasPrefix(definition.Path, "//") || strings.ContainsAny(definition.Path, "\\\r\n\t #") || (definition.Method != "GET" && definition.Method != "HEAD") || definition.MaxRedirects < 0 || definition.MaxRedirects > 2 || (definition.ProxyMode != "direct" && definition.ProxyMode != "configured") {
					return errors.New("invalid_http_target")
				}
			}
			if definition.Kind == "tcp" {
				if definition.Port == 0 || definition.Host == "" {
					return errors.New("invalid_tcp_target")
				}
			}
			if definition.Kind == "dns_name" && !hostnamePattern.MatchString(definition.Hostname) {
				return errors.New("invalid_dns_name")
			}
			if definition.Kind != "tcp" && definition.Kind != "https" && definition.Kind != "dns_name" {
				return errors.New("invalid_target")
			}
		default:
			return errors.New("invalid_destination")
		}
	}
	ids := map[string]bool{}
	for _, step := range p.Steps {
		if _, e := uuid.Parse(step.ID); e != nil || ids[step.ID] {
			return errors.New("invalid_step_identity")
		}
		ids[step.ID] = true
		if step.DestinationID != nil {
			if _, ok := destinations[*step.DestinationID]; !ok {
				return errors.New("unknown_destination")
			}
		} else if step.Method != "route_lookup" && step.Method != "neighbor_lookup" {
			return errors.New("destination_required")
		}
		switch step.Method {
		case "route_lookup", "neighbor_lookup":
		case "icmp":
			if step.PacketCount < 1 || step.PacketCount > 5 || step.TimeoutMS < 1 || step.TimeoutMS > 2000 || step.PayloadBytes < 0 || step.PayloadBytes > 1024 {
				return errors.New("icmp_limit_exceeded")
			}
		case "dns":
			if step.TimeoutMS < 1 || step.TimeoutMS > 2000 || step.Retries < 0 || step.Retries > 1 || len(step.ResolverDestinationIDs) > 2 || (step.QueryType != "A" && step.QueryType != "AAAA") {
				return errors.New("dns_limit_exceeded")
			}
			for _, id := range step.ResolverDestinationIDs {
				if destinations[id].Kind != "observed_resolver" {
					return errors.New("invalid_resolver")
				}
			}
		case "tcp", "tls", "http":
			if step.TimeoutMS < 1 || step.TimeoutMS > 5000 {
				return errors.New("timeout_limit_exceeded")
			}
			if step.Method == "http" && (step.ResponseLimitBytes < 1 || step.ResponseLimitBytes > 65536) {
				return errors.New("response_limit_exceeded")
			}
		default:
			return errors.New("unsupported_method")
		}
	}
	return nil
}
func ValidateDestination(target Target, address netip.Addr, route networkcontext.RouteSelection) error {
	if !address.IsValid() {
		return ErrBlocked
	}
	address = address.Unmap()
	if address.IsUnspecified() || address.IsMulticast() || address == netip.MustParseAddr("255.255.255.255") {
		return ErrBlocked
	}
	for _, blocked := range []string{"169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"} {
		if address.WithZone("") == netip.MustParseAddr(blocked) {
			return ErrBlocked
		}
	}
	if address.Is4() {
		bytes := address.As4()
		numeric := binary.BigEndian.Uint32(bytes[:])
		if bytes[0] == 0 {
			return ErrBlocked
		}
		for _, raw := range route.LocalPrefixes {
			prefix, e := netip.ParsePrefix(raw)
			if e != nil || !prefix.Addr().Is4() || prefix.Bits() > 30 {
				continue
			}
			network := prefix.Masked().Addr().As4()
			mask := uint32(0xffffffff) >> prefix.Bits()
			if numeric == binary.BigEndian.Uint32(network[:])|mask {
				return ErrBlocked
			}
		}
	}
	if address.IsLoopback() {
		return ErrBlocked
	} // Stub exception requires the runner's fresh resolver proof.
	// The planned gateway is a claim the server made from stored evidence; only
	// the live selected route says where traffic actually leaves this host. They
	// must agree for EVERY gateway target, not only the link-local ones.
	if target.Kind == "observed_gateway" && (route.NextHop == nil || *route.NextHop != address.WithZone("").String()) {
		return ErrBlocked
	}
	if address.IsLinkLocalUnicast() {
		if target.Kind != "observed_gateway" || target.Zone == nil || *target.Zone != route.InterfaceKey {
			return ErrBlocked
		}
	}
	if route.InterfaceKey == "" || route.ContextKey == "" || route.Attribution == "unknown" {
		return ErrUnsupportedContext
	}
	return nil
}
func commandError(err error) string {
	if errors.Is(err, ErrBlocked) {
		return "destination_blocked"
	}
	if errors.Is(err, ErrUnsupportedContext) {
		return "unsupported_context"
	}
	return "execution_error"
}
