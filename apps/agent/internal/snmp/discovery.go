package snmp

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
)

// DeviceIdentity contains basic system identifiers.
type DeviceIdentity struct {
	SysDescr    string
	SysObjectID string
	SysName     string
}

// DiscoveryConfig controls SNMP discovery behavior.
type DiscoveryConfig struct {
	ClientConfig SNMPClientConfig
	Concurrency  int
}

// DefaultDiscoveryConfig provides baseline discovery settings.
var DefaultDiscoveryConfig = DiscoveryConfig{
	ClientConfig: SNMPClientConfig{
		Version: gosnmp.Version2c,
		Auth: SNMPAuth{
			Community: "public",
		},
		Timeout: 2 * time.Second,
		Retries: 1,
	},
	Concurrency: 64,
}

const maxDiscoveryHosts = 65536

// DiscoverDevices scans a subnet and returns devices that respond to SNMP.
func DiscoverDevices(subnet string) ([]SNMPDevice, error) {
	network, err := parseSubnet(subnet)
	if err != nil {
		return nil, err
	}
	if network == nil {
		return nil, nil
	}

	targets, err := expandSubnet(network)
	if err != nil {
		return nil, err
	}
	if len(targets) == 0 {
		return nil, nil
	}

	config := normalizeDiscoveryConfig(DefaultDiscoveryConfig)
	workers := config.Concurrency
	if workers > len(targets) {
		workers = len(targets)
	}

	jobs := make(chan net.IP)
	var wg sync.WaitGroup
	var mu sync.Mutex
	devices := make([]SNMPDevice, 0, len(targets))

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ip := range jobs {
				if ok := probeDeviceWithConfig(ip.String(), config); !ok {
					continue
				}
				device := SNMPDevice{
					IP:             ip.String(),
					Port:           config.ClientConfig.Port,
					Version:        config.ClientConfig.Version,
					Auth:           config.ClientConfig.Auth,
					Timeout:        config.ClientConfig.Timeout,
					Retries:        config.ClientConfig.Retries,
					MaxRepetitions: config.ClientConfig.MaxRepetitions,
				}
				mu.Lock()
				devices = append(devices, device)
				mu.Unlock()
			}
		}()
	}

	for _, target := range targets {
		jobs <- target
	}
	close(jobs)

	wg.Wait()
	return devices, nil
}

// ProbeDevice checks whether a device responds to SNMP.
func ProbeDevice(ip string) bool {
	return probeDeviceWithConfig(ip, normalizeDiscoveryConfig(DefaultDiscoveryConfig))
}

// IdentifyDevice returns basic system identifiers from the target.
func IdentifyDevice(ip string) (*DeviceIdentity, error) {
	config := normalizeDiscoveryConfig(DefaultDiscoveryConfig)
	clientConfig := config.ClientConfig
	clientConfig.Target = ip

	client, err := NewClient(clientConfig)
	if err != nil {
		return nil, err
	}
	defer client.Close()

	pdus, err := client.GetBulk([]string{
		"1.3.6.1.2.1.1.1.0",
		"1.3.6.1.2.1.1.2.0",
		"1.3.6.1.2.1.1.5.0",
	})
	if err != nil {
		return nil, err
	}

	identity := &DeviceIdentity{}
	for _, pdu := range pdus {
		switch pdu.Name {
		case "1.3.6.1.2.1.1.1.0":
			identity.SysDescr = snmpToString(pdu)
		case "1.3.6.1.2.1.1.2.0":
			identity.SysObjectID = snmpToString(pdu)
		case "1.3.6.1.2.1.1.5.0":
			identity.SysName = snmpToString(pdu)
		}
	}

	if identity.SysDescr == "" && identity.SysName == "" && identity.SysObjectID == "" {
		return nil, errors.New("SNMP response did not include system identity")
	}
	return identity, nil
}

func probeDeviceWithConfig(ip string, config DiscoveryConfig) bool {
	clientConfig := config.ClientConfig
	clientConfig.Target = ip

	client, err := NewClient(clientConfig)
	if err != nil {
		return false
	}
	defer client.Close()

	pdu, err := client.Get("1.3.6.1.2.1.1.1.0")
	if err != nil {
		return false
	}
	return pdu.Value != nil
}

func normalizeDiscoveryConfig(config DiscoveryConfig) DiscoveryConfig {
	if config.ClientConfig.Version == 0 {
		config.ClientConfig.Version = gosnmp.Version2c
	}
	if config.ClientConfig.Timeout == 0 {
		config.ClientConfig.Timeout = 2 * time.Second
	}
	if config.ClientConfig.Retries == 0 {
		config.ClientConfig.Retries = 1
	}
	if config.ClientConfig.Port == 0 {
		config.ClientConfig.Port = 161
	}
	if config.Concurrency <= 0 {
		config.Concurrency = 64
	}
	if config.ClientConfig.Version != gosnmp.Version3 && config.ClientConfig.Auth.Community == "" {
		config.ClientConfig.Auth.Community = "public"
	}
	return config
}

func parseSubnet(subnet string) (*net.IPNet, error) {
	subnet = strings.TrimSpace(subnet)
	if subnet == "" {
		return nil, nil
	}

	if strings.Contains(subnet, "/") {
		_, ipNet, err := net.ParseCIDR(subnet)
		if err != nil {
			return nil, fmt.Errorf("invalid subnet %q: %w", subnet, err)
		}
		return ipNet, nil
	}

	ip := net.ParseIP(subnet)
	if ip == nil {
		return nil, fmt.Errorf("invalid IP %q", subnet)
	}
	mask := net.CIDRMask(32, 32)
	if ip.To4() == nil {
		mask = net.CIDRMask(128, 128)
	}
	return &net.IPNet{IP: ip, Mask: mask}, nil
}

func expandSubnet(network *net.IPNet) ([]net.IP, error) {
	if network == nil || network.IP.To4() == nil {
		return nil, nil
	}

	ones, bits := network.Mask.Size()
	hosts := uint64(1) << uint(bits-ones)
	if hosts > maxDiscoveryHosts {
		return nil, fmt.Errorf("subnet too large for discovery: %s", network.String())
	}

	ips := make([]net.IP, 0, int(hosts))
	for ip := network.IP.Mask(network.Mask); network.Contains(ip); ip = nextIP(ip) {
		ipCopy := make(net.IP, len(ip))
		copy(ipCopy, ip)
		ips = append(ips, ipCopy)
	}
	return ips, nil
}

func nextIP(ip net.IP) net.IP {
	next := make(net.IP, len(ip))
	copy(next, ip)
	for i := len(next) - 1; i >= 0; i-- {
		next[i]++
		if next[i] != 0 {
			break
		}
	}
	return next
}

func snmpToString(pdu gosnmp.SnmpPDU) string {
	if pdu.Value == nil {
		return ""
	}
	switch value := pdu.Value.(type) {
	case string:
		return value
	case []byte:
		return string(value)
	default:
		return gosnmp.ToBigInt(value).String()
	}
}
