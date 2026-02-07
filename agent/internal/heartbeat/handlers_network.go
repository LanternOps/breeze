package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/discovery"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/snmppoll"
)

func init() {
	handlerRegistry[tools.CmdNetworkDiscovery] = handleNetworkDiscovery
	handlerRegistry[tools.CmdSnmpPoll] = handleSnmpPoll
}

func handleNetworkDiscovery(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	scanConfig := discovery.ScanConfig{
		Subnets:          tools.GetPayloadStringSlice(cmd.Payload, "subnets"),
		ExcludeIPs:       tools.GetPayloadStringSlice(cmd.Payload, "excludeIps"),
		Methods:          tools.GetPayloadStringSlice(cmd.Payload, "methods"),
		PortRanges:       tools.GetPayloadStringSlice(cmd.Payload, "portRanges"),
		SNMPCommunities:  tools.GetPayloadStringSlice(cmd.Payload, "snmpCommunities"),
		Timeout:          time.Duration(tools.GetPayloadInt(cmd.Payload, "timeout", 2)) * time.Second,
		Concurrency:      tools.GetPayloadInt(cmd.Payload, "concurrency", 128),
		DeepScan:         tools.GetPayloadBool(cmd.Payload, "deepScan", false),
		IdentifyOS:       tools.GetPayloadBool(cmd.Payload, "identifyOS", false),
		ResolveHostnames: tools.GetPayloadBool(cmd.Payload, "resolveHostnames", false),
	}
	scanner := discovery.NewScanner(scanConfig)
	hosts, err := scanner.Scan()
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"jobId":           tools.GetPayloadString(cmd.Payload, "jobId", ""),
		"hosts":           hosts,
		"hostsScanned":    0,
		"hostsDiscovered": len(hosts),
	}, time.Since(start).Milliseconds())
}

func handleSnmpPoll(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	target, errResult := tools.RequirePayloadString(cmd.Payload, "target")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	version := tools.GetPayloadString(cmd.Payload, "version", "v2c")
	var snmpVersion snmppoll.SNMPVersion
	switch version {
	case "v1":
		snmpVersion = 0x00
	case "v3":
		snmpVersion = 0x03
	default:
		snmpVersion = 0x01
	}

	device := snmppoll.SNMPDevice{
		IP:      target,
		Port:    uint16(tools.GetPayloadInt(cmd.Payload, "port", 161)),
		Version: snmpVersion,
		Auth: snmppoll.SNMPAuth{
			Community: tools.GetPayloadString(cmd.Payload, "community", "public"),
			Username:  tools.GetPayloadString(cmd.Payload, "username", ""),
		},
		OIDs:    tools.GetPayloadStringSlice(cmd.Payload, "oids"),
		Timeout: time.Duration(tools.GetPayloadInt(cmd.Payload, "timeout", 2)) * time.Second,
		Retries: tools.GetPayloadInt(cmd.Payload, "retries", 1),
	}

	metrics, err := snmppoll.CollectMetrics(device)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"deviceId": tools.GetPayloadString(cmd.Payload, "deviceId", ""),
		"metrics":  metrics,
	}, time.Since(start).Milliseconds())
}
