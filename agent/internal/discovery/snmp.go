package discovery

import (
	"errors"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/gosnmp/gosnmp"
)

// DiscoverSNMP queries basic SNMP system OIDs for each target, trying each
// credential in order until one answers. Per-target failures are logged at
// Debug; one Info summary per scan says which credentials were tried and why
// the silent targets stayed silent (issue #6234 — a v3 profile probed as
// v2c/public was indistinguishable from "device does not speak SNMP").
func DiscoverSNMP(targets []net.IP, creds []SNMPCredential, timeout time.Duration, workers int) map[string]*SNMPInfo {
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
	if len(creds) == 0 {
		slog.Warn("SNMP discovery skipped: no usable credentials", "targets", len(targets))
		return results
	}

	jobs := make(chan net.IP)
	var wg sync.WaitGroup
	var mu sync.Mutex
	failures := make(map[string]int)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ip := range jobs {
				info, outcomes := querySNMP(ip.String(), creds, timeout)
				mu.Lock()
				if info != nil {
					results[ip.String()] = info
				} else {
					for _, o := range outcomes {
						failures[o.class]++
					}
				}
				mu.Unlock()
			}
		}()
	}

	for _, target := range targets {
		jobs <- target
	}
	close(jobs)

	wg.Wait()

	tried := make([]string, 0, len(creds))
	for _, c := range creds {
		tried = append(tried, c.Describe())
	}
	attrs := []any{
		"targets", len(targets),
		"responded", len(results),
		"credentials", tried,
	}
	for class, n := range failures {
		attrs = append(attrs, "failed_"+class, n)
	}
	if failures["credentials_rejected"] > 0 {
		slog.Warn("SNMP discovery: target(s) rejected the configured credentials", attrs...)
	} else {
		slog.Info("SNMP discovery finished", attrs...)
	}
	return results
}

// snmpProbeOutcome records why one credential failed against one target.
type snmpProbeOutcome struct {
	credential string
	class      string
	err        error
}

var sysOIDs = []string{"1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.2.0", "1.3.6.1.2.1.1.5.0"}

// querySNMP tries each credential in order and returns the first system-group
// answer. When nothing answers it returns the per-credential outcomes so the
// caller can say why.
func querySNMP(target string, creds []SNMPCredential, timeout time.Duration) (*SNMPInfo, []snmpProbeOutcome) {
	var outcomes []snmpProbeOutcome
	for _, cred := range creds {
		if !cred.usable() {
			continue
		}
		info, err := querySNMPWith(target, cred, timeout)
		if info != nil {
			return info, nil
		}
		class := classifySNMPProbeError(err)
		outcomes = append(outcomes, snmpProbeOutcome{credential: cred.Describe(), class: class, err: err})
		slog.Debug("SNMP probe failed", "target", target, "credential", cred.Describe(), "class", class, "error", err)
	}
	return nil, outcomes
}

// querySNMPWith performs one system-group GET with one credential. It never
// substitutes a different version or community than the credential names:
// a v3 credential produces a v3/USM exchange or nothing.
func querySNMPWith(target string, cred SNMPCredential, timeout time.Duration) (*SNMPInfo, error) {
	client, err := snmppoll.NewClient(cred.clientConfig(target, timeout))
	if err != nil {
		return nil, err
	}
	defer client.Close()

	pdus, err := client.GetMulti(sysOIDs)
	if err != nil {
		return nil, err
	}

	info := &SNMPInfo{}
	for _, variable := range pdus {
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
		return nil, errors.New("SNMP response carried no system-group values")
	}
	return info, nil
}

func snmpToString(variable gosnmp.SnmpPDU) string {
	if variable.Value == nil {
		return ""
	}
	switch value := variable.Value.(type) {
	case string:
		return value
	case []byte:
		// Same hazard snmppoll.OctetStringToText guards: sysDescr/sysName/sysObjectID land
		// in Postgres `text`, and a device that answers with raw binary would
		// otherwise smuggle NUL bytes into the insert. Non-text payloads become
		// lowercase hex; ordinary text is untouched.
		return snmppoll.OctetStringToText(value)
	default:
		return gosnmp.ToBigInt(value).String()
	}
}
