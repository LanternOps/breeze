package networkdiagnostic

// Bounded routed tracing (topology M3 Task 9).
//
// Protocol choice: every platform sends ICMP echo requests with an increasing
// TTL/hop limit and reads the ICMP Time Exceeded / Echo Reply / Destination
// Unreachable that comes back. UDP-to-high-port tracing is deliberately not
// used: receiving the ICMP errors it provokes needs either a raw ICMP socket
// (the same privilege ICMP echo needs) or the Linux-only IP_RECVERR error
// queue, and the Windows ICMP API (IcmpSendEcho2Ex / Icmp6SendEcho2) — the only
// unprivileged tracing primitive Windows offers — is echo-only. One protocol on
// every OS keeps results comparable across collectors.
//
// Privilege: Windows uses the ICMP helper API, which needs no elevation. Linux
// and macOS need a raw ICMP socket, which the agent service already holds for
// the M1 `icmp` step; when it cannot be opened the capability is not
// advertised and a delivered trace returns `unsupported`. Nothing here ever
// requests more privilege or falls back to an external program.
//
// Truthfulness: an unanswered probe is a null-address `timeout` hop, never an
// invented responder. A probe cut short by the run deadline or a cancellation
// is not recorded as a hop at all. Trace hops are evidence only; nothing on the
// server derives topology nodes or relationships from them.

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"time"
)

const (
	TraceMaxHops          = 30
	TraceMaxProbesPerHop  = 2
	TraceHopTimeout       = time.Second
	TraceExecutionCeiling = 60 * time.Second
	// traceHopBudget is the byte budget for the serialized hop array inside the
	// 8 KiB step-details bound, leaving room for the fixed trace envelope.
	traceHopBudget = 8192 - 320
)

var ErrTraceUnsupported = errors.New("trace_unsupported")

type TraceReplyKind int

const (
	TraceTimeExceeded TraceReplyKind = iota + 1
	TraceEchoReply
	TraceUnreachable
)

// TraceReply is one ICMP answer matched to the probe that provoked it.
type TraceReply struct {
	Kind    TraceReplyKind
	Address netip.Addr
	RTT     time.Duration
}

// SourceBinding is the live, validated route attribution a trace must leave
// through: the selected source address and interface of the pinned context.
type SourceBinding struct {
	Address      netip.Addr
	InterfaceKey string
	OSIndex      uint32
	ContextKey   string
}

// TraceTransport sends exactly one probe. Implementations must never resolve a
// name, change the destination, or send more than one packet per call.
type TraceTransport interface {
	Probe(ctx context.Context, ttl, attempt int, destination netip.Addr, source SourceBinding) (TraceReply, error)
}

type TracePlan struct {
	Destination  netip.Addr
	Source       SourceBinding
	MaxHops      int
	ProbesPerHop int
	HopTimeout   time.Duration
	// Quality is the route attribution quality for the step; a responding hop
	// inherits it, an unanswered hop is `unknown`.
	Quality string
}

type TraceHop struct {
	TTL                int      `json:"ttl"`
	Attempt            int      `json:"attempt"`
	Address            *string  `json:"address"`
	RTTMS              *float64 `json:"rttMs"`
	Outcome            string   `json:"outcome"`
	AttributionQuality string   `json:"attributionQuality"`
}

type TraceDetails struct {
	Protocol           string     `json:"protocol"`
	DestinationReached bool       `json:"destinationReached"`
	MaxHops            int        `json:"maxHops"`
	ProbesPerHop       int        `json:"probesPerHop"`
	HopsOmitted        int        `json:"hopsOmitted"`
	Hops               []TraceHop `json:"hops"`
}

type TraceStop string

const (
	TraceStopDestinationReached TraceStop = "destination_reached"
	TraceStopUnreachable        TraceStop = "destination_unreachable"
	TraceStopMaxHops            TraceStop = "max_hops"
	TraceStopExecutionDeadline  TraceStop = "execution_deadline"
	TraceStopCancelled          TraceStop = "cancelled"
	TraceStopUnsupported        TraceStop = "unsupported"
	TraceStopProbeFailed        TraceStop = "probe_failed"
	TraceStopInvalidPlan        TraceStop = "invalid_plan"
)

type TraceResult struct {
	Details   TraceDetails
	Stop      TraceStop
	Truncated bool
	hopBytes  int
}

func newTraceResult(plan TracePlan) TraceResult {
	return TraceResult{Details: TraceDetails{Protocol: "icmp_echo", MaxHops: plan.MaxHops, ProbesPerHop: plan.ProbesPerHop, Hops: []TraceHop{}}}
}

// Append records one probe outcome within the remaining byte budget. A hop
// that no longer fits is counted in HopsOmitted and marks the result truncated;
// it is never silently dropped.
func (r *TraceResult) Append(hop TraceHop) {
	encoded, e := json.Marshal(hop)
	size := len(encoded) + 1
	if e != nil || r.hopBytes+size > traceHopBudget {
		r.Details.HopsOmitted++
		r.Truncated = true
		return
	}
	r.hopBytes += size
	r.Details.Hops = append(r.Details.Hops, hop)
}

func validTracePlan(plan TracePlan) bool {
	return plan.Destination.IsValid() && plan.Source.Address.IsValid() &&
		plan.MaxHops >= 1 && plan.MaxHops <= TraceMaxHops &&
		plan.ProbesPerHop >= 1 && plan.ProbesPerHop <= TraceMaxProbesPerHop
}

// RunTrace probes TTL 1..MaxHops, ProbesPerHop times each, while the context
// remains valid, and stops at destination confirmation or an unreachable.
func RunTrace(ctx context.Context, plan TracePlan, transport TraceTransport) TraceResult {
	result := newTraceResult(plan)
	if transport == nil || !validTracePlan(plan) {
		result.Stop = TraceStopInvalidPlan
		return result
	}
	hopTimeout := plan.HopTimeout
	if hopTimeout <= 0 || hopTimeout > TraceHopTimeout {
		hopTimeout = TraceHopTimeout
	}
	destination := plan.Destination.WithZone("")
	quality := plan.Quality
	if quality == "" {
		quality = "unknown"
	}
	for ttl := 1; ttl <= plan.MaxHops; ttl++ {
		unreachable := false
		for attempt := 1; attempt <= plan.ProbesPerHop; attempt++ {
			if stop := contextStop(ctx); stop != "" {
				result.Stop = stop
				return result
			}
			hopCtx, cancel := context.WithTimeout(ctx, hopTimeout)
			reply, err := transport.Probe(hopCtx, ttl, attempt, plan.Destination, plan.Source)
			cancel()
			hop := TraceHop{TTL: ttl, Attempt: attempt, AttributionQuality: "unknown"}
			switch {
			case err == nil && reply.Address.IsValid():
				address := reply.Address.WithZone("").String()
				rtt := float64(reply.RTT.Microseconds()) / 1000
				if rtt < 0 {
					rtt = 0
				}
				hop.Address, hop.RTTMS, hop.AttributionQuality = &address, &rtt, quality
				hop.Outcome = "reply"
				if reply.Kind == TraceUnreachable {
					hop.Outcome = "unreachable"
				}
			case err == nil:
				// A reply without a responder cannot be attributed to anything.
				result.Stop = TraceStopProbeFailed
				return result
			case errors.Is(err, ErrTraceUnsupported):
				hop.Outcome = "unsupported"
				result.Append(hop)
				result.Stop = TraceStopUnsupported
				return result
			case errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled):
				// Only a probe that used its whole hop budget is a hop gap; one cut
				// short by the run deadline or a cancellation is not evidence.
				if stop := contextStop(ctx); stop != "" {
					result.Stop = stop
					return result
				}
				hop.Outcome = "timeout"
			default:
				result.Stop = TraceStopProbeFailed
				return result
			}
			result.Append(hop)
			if hop.Outcome == "reply" && reply.Kind == TraceEchoReply && reply.Address.WithZone("") == destination {
				result.Details.DestinationReached = true
				result.Stop = TraceStopDestinationReached
				return result
			}
			if hop.Outcome == "unreachable" {
				unreachable = true
			}
		}
		if unreachable {
			result.Stop = TraceStopUnreachable
			return result
		}
	}
	result.Stop = TraceStopMaxHops
	return result
}

func contextStop(ctx context.Context) TraceStop {
	switch {
	case ctx.Err() == nil:
		return ""
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return TraceStopExecutionDeadline
	default:
		return TraceStopCancelled
	}
}

// traceStepOutcome maps a finished trace onto the M1 step state vocabulary.
// Not reaching the destination is `failed_check` evidence of the traced path,
// which the server's health assessment treats as unconfirmed rather than down.
func traceStepOutcome(stop TraceStop) (state, reason string) {
	switch stop {
	case TraceStopDestinationReached:
		return "succeeded", ""
	case TraceStopMaxHops:
		return "failed_check", "trace_destination_not_reached"
	case TraceStopUnreachable:
		return "failed_check", "trace_destination_unreachable"
	case TraceStopExecutionDeadline:
		return "timeout", "execution_deadline"
	case TraceStopCancelled:
		return "cancelled", "cancelled"
	case TraceStopUnsupported:
		return "unsupported", "trace_unsupported"
	case TraceStopInvalidPlan:
		return "execution_error", "invalid_plan"
	default:
		return "execution_error", "trace_probe_failed"
	}
}
