package discovery

import (
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/gosnmp/gosnmp"
)

// DiscoverSNMP queries basic SNMP system OIDs for each target.
func DiscoverSNMP(targets []net.IP, communities []string, timeout time.Duration, workers int) map[string]*SNMPInfo {
	results := make(map[string]*SNMPInfo)
	if len(targets) == 0 {
		return results
	}
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	if workers <= 0 {
		workers = 64
	}
	if len(communities) == 0 {
		communities = []string{"public"}
	}

	jobs := make(chan net.IP)
	var wg sync.WaitGroup
	var mu sync.Mutex

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ip := range jobs {
				info := querySNMP(ip.String(), communities, timeout)
				if info != nil {
					mu.Lock()
					results[ip.String()] = info
					mu.Unlock()
				}
			}
		}()
	}

	for _, target := range targets {
		jobs <- target
	}
	close(jobs)

	wg.Wait()
	return results
}

func querySNMP(target string, communities []string, timeout time.Duration) *SNMPInfo {
	for _, community := range communities {
		community = strings.TrimSpace(community)
		if community == "" {
			continue
		}

		if strings.HasPrefix(strings.ToLower(community), "v3:") {
			username := strings.TrimPrefix(community, "v3:")
			info := querySNMPv3(target, username, timeout)
			if info != nil {
				return info
			}
			continue
		}

		info := querySNMPv2c(target, community, timeout)
		if info != nil {
			return info
		}
	}
	return nil
}

func querySNMPv2c(target, community string, timeout time.Duration) *SNMPInfo {
	snmp := &gosnmp.GoSNMP{
		Target:    target,
		Port:      161,
		Community: community,
		Version:   gosnmp.Version2c,
		Timeout:   timeout,
		Retries:   1,
	}

	if err := snmp.Connect(); err != nil {
		return nil
	}
	defer snmp.Conn.Close()

	response, err := snmp.Get([]string{"1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.2.0", "1.3.6.1.2.1.1.5.0"})
	if err != nil || response == nil {
		return nil
	}

	info := &SNMPInfo{}
	for _, variable := range response.Variables {
		switch variable.Name {
		case ".1.3.6.1.2.1.1.1.0":
			info.SysDescr = snmpToString(variable)
		case ".1.3.6.1.2.1.1.2.0":
			info.SysObjectID = snmpToString(variable)
		case ".1.3.6.1.2.1.1.5.0":
			info.SysName = snmpToString(variable)
		}
	}

	if info.SysDescr == "" && info.SysName == "" && info.SysObjectID == "" {
		return nil
	}
	return info
}

func querySNMPv3(target, username string, timeout time.Duration) *SNMPInfo {
	if username == "" {
		return nil
	}
	params := &gosnmp.UsmSecurityParameters{UserName: username}
	gs := &gosnmp.GoSNMP{
		Target:             target,
		Port:               161,
		Version:            gosnmp.Version3,
		Timeout:            timeout,
		Retries:            1,
		SecurityModel:      gosnmp.UserSecurityModel,
		MsgFlags:           gosnmp.NoAuthNoPriv,
		SecurityParameters: params,
	}

	if err := gs.Connect(); err != nil {
		slog.Debug("SNMP v3 connect failed", "target", target, "error", err)
		return nil
	}
	defer gs.Conn.Close()

	response, err := gs.Get([]string{"1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.2.0", "1.3.6.1.2.1.1.5.0"})
	if err != nil || response == nil {
		return nil
	}

	info := &SNMPInfo{}
	for _, variable := range response.Variables {
		switch variable.Name {
		case ".1.3.6.1.2.1.1.1.0":
			info.SysDescr = snmpToString(variable)
		case ".1.3.6.1.2.1.1.2.0":
			info.SysObjectID = snmpToString(variable)
		case ".1.3.6.1.2.1.1.5.0":
			info.SysName = snmpToString(variable)
		}
	}

	if info.SysDescr == "" && info.SysName == "" && info.SysObjectID == "" {
		return nil
	}
	return info
}

// collectFdbForDevice walks the bridge-FDB tables for a single SNMP device and
// returns the assembled MAC→port adjacency entries. It tries each community in
// turn and returns nil on any SNMP error so a failing device degrades to no
// adjacency without aborting the scan (mirroring querySNMP's nil-on-failure
// pattern). No live SNMP server is contacted in tests — unreachable targets
// degrade to an empty slice.
func collectFdbForDevice(target string, communities []string, timeout time.Duration) []snmppoll.FdbEntry {
	if len(communities) == 0 {
		communities = []string{"public"}
	}
	for _, community := range communities {
		community = strings.TrimSpace(community)
		if community == "" {
			continue
		}
		cfg := snmppoll.SNMPClientConfig{Target: target, Timeout: timeout}
		if strings.HasPrefix(strings.ToLower(community), "v3:") {
			cfg.Version = gosnmp.Version3
			cfg.Auth = snmppoll.SNMPAuth{Username: strings.TrimPrefix(community, "v3:")}
		} else {
			cfg.Version = gosnmp.Version2c
			cfg.Auth = snmppoll.SNMPAuth{Community: community}
		}
		client, err := snmppoll.NewClient(cfg)
		if err != nil {
			continue
		}
		fdbPort, err := client.BulkWalk("1.3.6.1.2.1.17.4.3.1.2")
		if err != nil {
			client.Close()
			continue
		}
		basePort, _ := client.BulkWalk("1.3.6.1.2.1.17.1.4.1.2")
		ifNames, _ := client.BulkWalk("1.3.6.1.2.1.31.1.1.1.1")
		qBridge, _ := client.BulkWalk("1.3.6.1.2.1.17.7.1.2.2.1.2")
		client.Close()
		return snmppoll.AssembleFdbEntries(fdbPort, basePort, ifNames, qBridge)
	}
	return nil
}

func snmpToString(variable gosnmp.SnmpPDU) string {
	if variable.Value == nil {
		return ""
	}
	switch value := variable.Value.(type) {
	case string:
		return value
	case []byte:
		return string(value)
	default:
		return gosnmp.ToBigInt(value).String()
	}
}
