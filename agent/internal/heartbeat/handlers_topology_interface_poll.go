package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/snmppoll"
)

// Topology interface polling (M3 Task 3). The server arms the poll and names
// every ifIndex→interface binding; this handler only reads those ports from the
// named target and answers with an if_metrics envelope as the command result.
// A device-side failure (timeout, auth) is a completed command whose envelope
// outcome says so; only a command the agent cannot run is a failed command.

func init() {
	handlerRegistry[tools.CmdTopologyInterfacePoll] = handleTopologyInterfacePoll
}

// interfacePollSlots bounds concurrent polls so a burst of arms cannot fan out
// unbounded SNMP sessions from one agent.
var interfacePollSlots = make(chan struct{}, 2)

// openInterfaceMetricReader is the transport seam (stubbed in tests).
var openInterfaceMetricReader = func(device snmppoll.SNMPDevice) (snmppoll.InterfaceMetricReader, func(), error) {
	client, err := snmppoll.NewClient(device.ClientConfig())
	if err != nil {
		return nil, nil, err
	}
	return snmppoll.ClientInterfaceMetricReader{Client: client}, client.Close, nil
}

func handleTopologyInterfacePoll(h *Heartbeat, cmd Command) tools.CommandResult {
	started := time.Now()
	raw, err := json.Marshal(cmd.Payload)
	if err != nil {
		return tools.NewErrorResult(err, 0)
	}
	command, err := snmppoll.DecodeInterfacePollCommandV1(raw)
	if err != nil {
		return tools.NewErrorResult(err, 0)
	}
	device, err := command.Device()
	if err != nil {
		return tools.NewErrorResult(err, 0)
	}
	select {
	case interfacePollSlots <- struct{}{}:
		defer func() { <-interfacePollSlots }()
	default:
		return tools.NewErrorResult(errors.New("interface poll concurrency limit reached"), 0)
	}

	deadline := started.Add(time.Duration(command.DeadlineMs) * time.Millisecond)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	if h != nil && h.stopChan != nil {
		done := make(chan struct{})
		defer close(done)
		go func() {
			select {
			case <-h.stopChan:
				cancel()
			case <-done:
			}
		}()
	}

	snapshot := snmppoll.InterfaceMetricSnapshot{Outcome: "failed"}
	reader, closeReader, err := openInterfaceMetricReader(device)
	if err != nil {
		reason := "unreachable"
		snapshot.ReasonCode = &reason
	} else {
		defer closeReader()
		snapshot, err = snmppoll.CollectInterfaceMetrics(ctx, reader, command.Request(deadline))
		if err != nil {
			return tools.NewErrorResult(err, time.Since(started).Milliseconds())
		}
	}
	envelope := command.Envelope(cmd.ID, started, time.Now(), snapshot)
	if err := envelope.Validate(); err != nil {
		return tools.NewErrorResult(err, time.Since(started).Milliseconds())
	}
	return tools.NewSuccessResult(envelope, time.Since(started).Milliseconds())
}
