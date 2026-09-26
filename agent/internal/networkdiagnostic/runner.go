package networkdiagnostic

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
)

func resultBase(command Command) Result {
	return Result{Version: 1, RunID: command.RunID, AttemptID: command.AttemptID, CommandID: command.CommandID, PlanDigest: command.PlanDigest, Steps: []StepResult{}}
}
func stepBase(command Command, step PlanStep) StepResult {
	return StepResult{ID: step.ID, State: "pending", Attribution: Attribution{OriginDeviceID: command.Plan.Origin.DeviceID, OriginAgentID: command.Plan.Origin.AgentID, RequestedMethod: step.Method, DestinationID: step.DestinationID, InterfaceID: command.Plan.Origin.InterfaceID, ContextKey: ptr(command.Plan.Origin.ContextKey), Quality: "unknown", EvidenceRefs: []string{}}, Details: Details{}}
}
func failStep(result StepResult, state, reason string) StepResult {
	now := time.Now().UTC()
	result.State = state
	if reason == "" {
		result.Reason = nil
	} else {
		result.Reason = ptr(reason)
	}
	result.FinishedAt = &now
	return result
}
func applyRoute(result *StepResult, route networkcontext.RouteSelection, address netip.Addr, port uint16) {
	result.Attribution.ResolvedIP = ptr(address.WithZone("").String())
	family := "ipv4"
	if address.Is6() {
		family = "ipv6"
	}
	result.Attribution.Family = ptr(family)
	if port != 0 {
		result.Attribution.Port = ptr(port)
	}
	result.Attribution.ContextKey = ptr(route.ContextKey)
	result.Attribution.NextHop = route.NextHop
	result.Attribution.Quality = route.Attribution
	if route.SourceAddress != "" {
		result.Attribution.LocalAddress = ptr(route.SourceAddress)
	}
	result.Attribution.ProxyUsed = ptr(false)
}
func requestRoute(ctx context.Context, io ProbeIO, origin Origin, ip netip.Addr) (networkcontext.RouteSelection, error) {
	request := networkcontext.RouteLookupRequest{ContextKey: origin.ContextKey, Destination: ip}
	if origin.InterfaceKey != nil {
		request.InterfaceKey = *origin.InterfaceKey
	}
	route, e := io.LookupRoute(ctx, request)
	if e != nil {
		return route, e
	}
	if route.ContextKey != origin.ContextKey || (origin.InterfaceKey != nil && route.InterfaceKey != *origin.InterfaceKey) {
		return route, ErrUnsupportedContext
	}
	return route, nil
}
func targetAddress(target Target) (string, uint16) {
	if target.Kind == "configured_target" && target.Definition != nil {
		d := target.Definition
		if d.Kind == "tcp" {
			return d.Host, d.Port
		}
		return d.Hostname, d.Port
	}
	return target.Address, target.Port
}
func compatibleFamily(ip netip.Addr, family string) bool {
	return ip.Unmap().Is4() == (family == "ipv4")
}

// Run executes the pinned server order. Sequential execution is deliberately
// within the two-step concurrency ceiling and makes cancellation deterministic.
func Run(parent context.Context, command Command, journal *Journal, io ProbeIO) Result {
	output := resultBase(command)
	if journal == nil || io == nil {
		return output
	}
	validateAt := time.Now()
	if journal.accepted(command) {
		validateAt = command.Plan.AcceptedAt.Add(time.Millisecond)
	}
	if e := ValidateCommand(command, validateAt); e != nil {
		for _, step := range command.Plan.Steps {
			output.Steps = append(output.Steps, failStep(stepBase(command, step), "execution_error", "invalid_plan"))
		}
		return output
	}
	if _, e := journal.Accept(command); e != nil {
		for _, step := range command.Plan.Steps {
			state, reason := "execution_error", "journal_unavailable"
			if errors.Is(e, ErrCancelled) {
				state, reason = "cancelled", "cancelled"
			}
			output.Steps = append(output.Steps, failStep(stepBase(command, step), state, reason))
		}
		return output
	}
	deadline := command.ExpiresAt
	executionDeadline := time.Now().Add(time.Duration(command.Plan.Limits.ExecutionTimeoutSeconds) * time.Second)
	if executionDeadline.Before(deadline) {
		deadline = executionDeadline
	}
	ctx, cancel := context.WithDeadline(parent, deadline)
	defer cancel()
	destinations := map[string]Target{}
	for _, d := range command.Plan.Destinations {
		destinations[d.ID] = d.Target
	}
	resolved := map[string][]netip.Addr{}
	addressSet := map[netip.Addr]bool{}
	resolverSet := map[netip.Addr]bool{}
	previousRoutes := map[string]networkcontext.RouteSelection{}
	for _, step := range command.Plan.Steps {
		result := stepBase(command, step)
		key := command.StepKey(step.ID)
		if old, exists := journal.Result(key); exists {
			if old != nil {
				output.Steps = append(output.Steps, *old)
				if len(old.Details.ResolvedAddresses) > 0 && step.DestinationID != nil {
					for _, raw := range old.Details.ResolvedAddresses {
						ip, e := netip.ParseAddr(raw)
						if e == nil {
							resolved[*step.DestinationID] = append(resolved[*step.DestinationID], ip)
							addressSet[ip] = true
						}
					}
				}
			} else {
				output.Steps = append(output.Steps, failStep(result, "execution_error", "outcome_indeterminate"))
			}
			continue
		}

		now := time.Now().UTC()
		result.StartedAt = &now
		started, e := journal.StartStep(key, result)
		if e != nil || !started {
			// A refusal the journal can name is that outcome, not an
			// unavailable journal: `journal_unavailable` stays reserved for a
			// genuine journal failure.
			state, reason := "execution_error", "journal_unavailable"
			switch {
			case errors.Is(e, ErrCancelled):
				state, reason = "cancelled", "cancelled"
			case errors.Is(e, ErrExpired):
				state, reason = "timeout", "execution_deadline"
			}
			output.Steps = append(output.Steps, failStep(result, state, reason))
			continue
		}
		if ctx.Err() != nil {
			state := "cancelled"
			reason := "cancelled"
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				state = "timeout"
				reason = "execution_deadline"
			}
			result = failStep(result, state, reason)
			if err := journal.FinishStep(key, result); err != nil {
				result = failStep(result, "execution_error", "journal_persistence_failed")
			}
			output.Steps = append(output.Steps, result)
			continue
		}
		result = executeStep(ctx, command, step, result, io, destinations, resolved, addressSet, resolverSet, previousRoutes)
		if e = journal.FinishStep(key, result); e != nil {
			result = failStep(result, "execution_error", "journal_persistence_failed")
		}
		output.Steps = append(output.Steps, result)
	}
	return output
}
func executeStep(parent context.Context, command Command, step PlanStep, result StepResult, io ProbeIO, destinations map[string]Target, resolved map[string][]netip.Addr, addressSet, resolverSet map[netip.Addr]bool, previousRoutes map[string]networkcontext.RouteSelection) StepResult {
	if step.DestinationID == nil {
		return failStep(result, "skipped", "target_not_configured")
	}
	target := destinations[*step.DestinationID]
	host, port := targetAddress(target)
	timeout := time.Duration(step.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	if step.Method == "icmp" {
		timeout *= time.Duration(step.PacketCount)
	}
	if step.Method == "trace" {
		// Worst case is every probe using its full hop timeout; the run's own
		// execution deadline (at most 60 s for trace_route) still caps it.
		timeout = time.Duration(step.MaxHops*step.ProbesPerHop) * time.Duration(step.HopTimeoutMS) * time.Millisecond
		if timeout > TraceExecutionCeiling {
			timeout = TraceExecutionCeiling
		}
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	if step.Method == "dns" {
		if target.Kind != "configured_target" || target.Definition == nil {
			return failStep(result, "unsupported", "target_not_configured")
		}
		current, e := io.Resolvers(ctx)
		if e != nil {
			return failStep(result, "unsupported", "unsupported_context")
		}
		approved := []networkcontext.ResolverRow{}
		var route networkcontext.RouteSelection
		for _, resolverID := range step.ResolverDestinationIDs {
			wanted := destinations[resolverID]
			matched := false
			for _, candidate := range current {
				if candidate.Address != wanted.Address || candidate.Port != wanted.Port || candidate.IsLocalStub != wanted.LocalStub {
					continue
				}
				if command.Plan.Origin.InterfaceKey != nil && (candidate.InterfaceKey == nil || *candidate.InterfaceKey != *command.Plan.Origin.InterfaceKey) {
					continue
				}
				ip, e := netip.ParseAddr(candidate.Address)
				if e != nil {
					continue
				}
				if !resolverSet[ip] && len(resolverSet) >= command.Plan.Limits.MaxResolvers {
					return failStep(result, "execution_error", "resolver_limit_exceeded")
				}
				if candidate.IsLocalStub && ip.IsLoopback() {
					route = networkcontext.RouteSelection{ContextKey: command.Plan.Origin.ContextKey, Attribution: "requested_unverified"}
					if command.Plan.Origin.InterfaceKey != nil {
						route.InterfaceKey = *command.Plan.Origin.InterfaceKey
					}
				} else {
					route, e = requestRoute(ctx, io, command.Plan.Origin, ip)
					if e != nil || ValidateDestination(wanted, ip, route) != nil {
						continue
					}
				}
				resolverSet[ip] = true
				approved = append(approved, candidate)
				matched = true
				break
			}
			if !matched {
				return failStep(result, "unsupported", "unsupported_context")
			}
		}
		if len(approved) == 0 {
			return failStep(result, "skipped", "target_not_configured")
		}
		resolution, e := io.Resolve(ctx, host, step.QueryType, approved, route, step.Retries)
		result.Attribution.ActualMethod = ptr("dns")
		if e != nil {
			return probeFailure(result, e)
		}
		resolverIP, parseErr := netip.ParseAddr(resolution.Resolver.Address)
		if parseErr != nil {
			return failStep(result, "execution_error", "invalid_resolver_attribution")
		}
		applyRoute(&result, resolution.Route, resolverIP, resolution.Resolver.Port)
		if resolution.Resolver.IsLocalStub {
			result.Attribution.Quality = "requested_unverified"
		}
		ips := resolution.Addresses
		if len(ips) > 2 {
			return failStep(result, "execution_error", "address_limit_exceeded")
		}
		accepted := []netip.Addr{}
		for _, ip := range ips {
			ip = ip.Unmap()
			if !compatibleFamily(ip, command.Plan.Family) {
				return failStep(result, "execution_error", "address_family_mismatch")
			}
			route, e := requestRoute(ctx, io, command.Plan.Origin, ip)
			if e != nil {
				return failStep(result, "unsupported", "unsupported_context")
			}
			if e = ValidateDestination(target, ip, route); e != nil {
				return failStep(result, "execution_error", commandError(e))
			}
			if !addressSet[ip] && len(addressSet) >= command.Plan.Limits.MaxTargetAddresses {
				return failStep(result, "execution_error", "address_limit_exceeded")
			}
			addressSet[ip] = true
			accepted = append(accepted, ip)
			result.Details.ResolvedAddresses = append(result.Details.ResolvedAddresses, ip.String())
		}
		if len(accepted) == 0 {
			return failStep(result, "failed_check", "dns_no_answer")
		}
		resolved[*step.DestinationID] = accepted
		if expected := target.Definition.ExpectedAddresses; len(expected) > 0 {
			matches := false
			for _, ip := range accepted {
				for _, want := range expected {
					if ip.String() == want {
						matches = true
					}
				}
			}
			if !matches {
				return failStep(result, "failed_check", "dns_answer_mismatch")
			}
		}
		return failStep(result, "succeeded", "")
	}
	var ip netip.Addr
	var e error
	if ip, e = netip.ParseAddr(host); e != nil {
		ips := resolved[*step.DestinationID]
		if len(ips) == 0 {
			return failStep(result, "skipped", "target_not_resolved")
		}
		ip = ips[0]
	}
	ip = ip.Unmap()
	if !compatibleFamily(ip, command.Plan.Family) {
		return failStep(result, "unsupported", "address_family_mismatch")
	}
	if !addressSet[ip] && len(addressSet) >= command.Plan.Limits.MaxTargetAddresses {
		return failStep(result, "execution_error", "address_limit_exceeded")
	}
	addressSet[ip] = true
	route, e := requestRoute(ctx, io, command.Plan.Origin, ip)
	if e != nil {
		return failStep(result, "unsupported", "unsupported_context")
	}
	if e = ValidateDestination(target, ip, route); e != nil {
		return failStep(result, "execution_error", commandError(e))
	}
	applyRoute(&result, route, ip, port)
	if previous, ok := previousRoutes[*step.DestinationID]; ok && (previous.InterfaceKey != route.InterfaceKey || previous.SourceAddress != route.SourceAddress || stringPtr(previous.NextHop) != stringPtr(route.NextHop)) {
		result.Attribution.RouteChanged = true
		result.Attribution.Quality = "requested_unverified"
	}
	previousRoutes[*step.DestinationID] = route
	var details Details
	switch step.Method {
	case "route_lookup":
		details = Details{}
	case "neighbor_lookup":
		if cached, ok := io.(interface {
			NeighborLookup(context.Context, netip.Addr, networkcontext.RouteSelection) (Details, error)
		}); ok {
			details, e = cached.NeighborLookup(ctx, ip, route)
		} else {
			return failStep(result, "unsupported", "neighbor_lookup_unavailable")
		}
	case "icmp":
		details, e = io.ICMP(ctx, ip, route, step.PacketCount, step.PayloadBytes)
	case "tcp":
		if port == 0 {
			return failStep(result, "skipped", "target_not_configured")
		}
		details, e = io.TCP(ctx, ip, port, route)
	case "tls", "http":
		if target.Definition == nil || target.Definition.Kind != "https" {
			return failStep(result, "skipped", "target_not_configured")
		}
		if target.Definition.ProxyMode != "direct" {
			return failStep(result, "unsupported", "proxy_not_configured")
		}
		details, e = io.HTTPS(ctx, ip, *target.Definition, route, step.Method, step.ResponseLimitBytes)
	case "trace":
		return executeTrace(ctx, step, result, io, ip, route)
	default:
		return failStep(result, "unsupported", "unsupported_method")
	}
	result.Attribution.ActualMethod = ptr(step.Method)
	result.Details = details
	if e != nil {
		return probeFailure(result, e)
	}
	return failStep(result, "succeeded", "")
}
func stringPtr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
func probeFailure(result StepResult, err error) StepResult {
	if errors.Is(err, ErrUnsupportedContext) {
		return failStep(result, "unsupported", "unsupported_context")
	}
	if errors.Is(err, context.Canceled) {
		return failStep(result, "cancelled", "cancelled")
	}
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return failStep(result, "timeout", "probe_timeout")
	}
	return failStep(result, "failed_check", "probe_failed")
}

// executeTrace runs one bounded trace to the already-validated literal address
// through the live route attribution the common prelude just checked.
func executeTrace(ctx context.Context, step PlanStep, result StepResult, io ProbeIO, ip netip.Addr, route networkcontext.RouteSelection) StepResult {
	tracer, ok := io.(TraceIO)
	if !ok {
		return failStep(result, "unsupported", "trace_unsupported")
	}
	transport, e := tracer.TraceTransport()
	if e != nil || transport == nil {
		return failStep(result, "unsupported", "trace_unsupported")
	}
	source, e := netip.ParseAddr(route.SourceAddress)
	if e != nil {
		return failStep(result, "unsupported", "unsupported_context")
	}
	trace := RunTrace(ctx, TracePlan{
		Destination:  ip,
		Source:       SourceBinding{Address: source, InterfaceKey: route.InterfaceKey, OSIndex: route.OSIndex, ContextKey: route.ContextKey},
		MaxHops:      step.MaxHops,
		ProbesPerHop: step.ProbesPerHop,
		HopTimeout:   time.Duration(step.HopTimeoutMS) * time.Millisecond,
		Quality:      result.Attribution.Quality,
	}, transport)
	result.Attribution.ActualMethod = ptr("trace")
	result.Details = Details{Trace: &trace.Details}
	result.Truncated = trace.Truncated
	state, reason := traceStepOutcome(trace.Stop)
	return failStep(result, state, reason)
}
