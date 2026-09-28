package snmppoll

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"time"

	"github.com/gosnmp/gosnmp"
)

// InterfacePollCommandV1 mirrors topologyInterfacePollCommandV1Schema.
type InterfacePollCommandV1 struct {
	Version                 int                   `json:"version"`
	Family                  string                `json:"family"`
	Binding                 InterfacePollBinding  `json:"binding"`
	ProducerEpoch           string                `json:"producerEpoch"`
	ConfigurationRevision   string                `json:"configurationRevision"`
	Sequence                string                `json:"sequence"`
	ExpectedIntervalSeconds int                   `json:"expectedIntervalSeconds"`
	DeadlineMs              int                   `json:"deadlineMs"`
	Target                  InterfacePollEndpoint `json:"target"`
	SNMP                    InterfacePollSNMP     `json:"snmp"`
	SNMPCommunity           *string               `json:"snmpCommunity,omitempty"`
	SNMPAuthPassphrase      *string               `json:"snmpAuthPassphrase,omitempty"`
	SNMPPrivPassphrase      *string               `json:"snmpPrivPassphrase,omitempty"`
	Interfaces              []InterfacePollTarget `json:"interfaces"`
}

// InterfacePollBinding is server-only scope/authority; the agent never uses it.
type InterfacePollBinding struct {
	OrgID        string `json:"orgId"`
	SiteID       string `json:"siteId"`
	AuthorityKey string `json:"authorityKey"`
	ArmID        string `json:"armId"`
}

type InterfacePollEndpoint struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
}

type InterfacePollSNMP struct {
	Version      string  `json:"version"`
	TimeoutMs    int     `json:"timeoutMs"`
	Retries      int     `json:"retries"`
	Username     *string `json:"username"`
	AuthProtocol *string `json:"authProtocol"`
	PrivProtocol *string `json:"privProtocol"`
}

var (
	pollAuthProtocols = map[string]gosnmp.SnmpV3AuthProtocol{"md5": gosnmp.MD5, "sha": gosnmp.SHA, "sha224": gosnmp.SHA224, "sha256": gosnmp.SHA256, "sha384": gosnmp.SHA384, "sha512": gosnmp.SHA512}
	pollPrivProtocols = map[string]gosnmp.SnmpV3PrivProtocol{"des": gosnmp.DES, "aes": gosnmp.AES, "aes192": gosnmp.AES192, "aes256": gosnmp.AES256, "aes192c": gosnmp.AES192C, "aes256c": gosnmp.AES256C}
	pollVersions      = map[string]SNMPVersion{"v1": Version1, "v2c": Version2c, "v3": Version3}
	lowerMACPattern   = regexp.MustCompile(`^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)
)

func optionalSecret(name string, v *string) error {
	if v != nil && (*v == "" || len(*v) > 4096) {
		return fmt.Errorf("%s must be 1-4096 bytes", name)
	}
	return nil
}

// Validate enforces the shared schema's rules.
func (c *InterfacePollCommandV1) Validate() error {
	if c.Version != 1 || c.Family != InterfaceMetricsFamily {
		return errors.New("unsupported interface poll version or family")
	}
	b := c.Binding
	if !uuidPattern.MatchString(b.OrgID) || !uuidPattern.MatchString(b.SiteID) || !uuidPattern.MatchString(b.ArmID) || !validKey(b.AuthorityKey) {
		return errors.New("invalid binding")
	}
	if !validKey(c.ProducerEpoch) || !validKey(c.ConfigurationRevision) {
		return errors.New("producerEpoch and configurationRevision must be 1-255 UTF-8 bytes")
	}
	if _, err := parseDecimal(c.Sequence); err != nil {
		return fmt.Errorf("sequence: %w", err)
	}
	if c.ExpectedIntervalSeconds < InterfaceMetricsMinInterval || c.ExpectedIntervalSeconds > InterfaceMetricsMaxInterval {
		return fmt.Errorf("expectedIntervalSeconds %d is out of range", c.ExpectedIntervalSeconds)
	}
	if c.DeadlineMs < 1000 || c.DeadlineMs > c.ExpectedIntervalSeconds*1000 {
		return errors.New("deadlineMs must be 1000ms up to the poll interval")
	}
	if net.ParseIP(c.Target.Address) == nil || c.Target.Port < 1 || c.Target.Port > 65535 {
		return errors.New("target must be an IP address and port")
	}
	if _, ok := pollVersions[c.SNMP.Version]; !ok {
		return fmt.Errorf("snmp version %q is unsupported", c.SNMP.Version)
	}
	if c.SNMP.TimeoutMs < 100 || c.SNMP.TimeoutMs > 10000 || c.SNMP.Retries < 0 || c.SNMP.Retries > 3 {
		return errors.New("snmp timeout/retries out of range")
	}
	if c.SNMP.Username != nil && (*c.SNMP.Username == "" || len(*c.SNMP.Username) > 255) {
		return errors.New("snmp username must be 1-255 bytes")
	}
	if c.SNMP.Version == "v3" && c.SNMP.Username == nil {
		return errors.New("SNMPv3 needs a username")
	}
	if c.SNMP.AuthProtocol != nil {
		if _, ok := pollAuthProtocols[*c.SNMP.AuthProtocol]; !ok {
			return fmt.Errorf("auth protocol %q is unsupported", *c.SNMP.AuthProtocol)
		}
	}
	if c.SNMP.PrivProtocol != nil {
		if _, ok := pollPrivProtocols[*c.SNMP.PrivProtocol]; !ok {
			return fmt.Errorf("privacy protocol %q is unsupported", *c.SNMP.PrivProtocol)
		}
		if c.SNMP.AuthProtocol == nil {
			return errors.New("privacy requires authentication")
		}
	}
	for name, v := range map[string]*string{"snmpCommunity": c.SNMPCommunity, "snmpAuthPassphrase": c.SNMPAuthPassphrase, "snmpPrivPassphrase": c.SNMPPrivPassphrase} {
		if err := optionalSecret(name, v); err != nil {
			return err
		}
	}
	if len(c.Interfaces) == 0 || len(c.Interfaces) > InterfaceMetricsMaxSamples {
		return fmt.Errorf("interfaces must hold 1-%d entries", InterfaceMetricsMaxSamples)
	}
	ids, indexes := map[string]bool{}, map[int]bool{}
	for i, t := range c.Interfaces {
		if !uuidPattern.MatchString(t.InterfaceID) || !validKey(t.InterfaceEpoch) || t.IfIndex < 1 || t.IfIndex > 2147483647 {
			return fmt.Errorf("interfaces[%d] is invalid", i)
		}
		if t.ExpectedName != nil && (*t.ExpectedName == "" || len(*t.ExpectedName) > 255) {
			return fmt.Errorf("interfaces[%d].expectedName is invalid", i)
		}
		if t.ExpectedPhysAddress != nil && !lowerMACPattern.MatchString(*t.ExpectedPhysAddress) {
			return fmt.Errorf("interfaces[%d].expectedPhysAddress is invalid", i)
		}
		if ids[t.InterfaceID] || indexes[t.IfIndex] {
			return fmt.Errorf("interfaces[%d] duplicates an interface or ifIndex", i)
		}
		ids[t.InterfaceID], indexes[t.IfIndex] = true, true
	}
	return nil
}

// DecodeInterfacePollCommandV1 strictly decodes and validates a command payload.
func DecodeInterfacePollCommandV1(data []byte) (InterfacePollCommandV1, error) {
	var c InterfacePollCommandV1
	if err := strictDecode(data, &c); err != nil {
		return InterfacePollCommandV1{}, err
	}
	if err := c.Validate(); err != nil {
		return InterfacePollCommandV1{}, err
	}
	return c, nil
}

// Device builds the SNMP session parameters, refusing a command whose
// credentials are missing (e.g. a terminally-erased payload replayed).
func (c *InterfacePollCommandV1) Device() (SNMPDevice, error) {
	version := pollVersions[c.SNMP.Version]
	device := SNMPDevice{IP: c.Target.Address, Port: uint16(c.Target.Port), Version: version,
		Timeout: time.Duration(c.SNMP.TimeoutMs) * time.Millisecond, Retries: c.SNMP.Retries}
	secret := func(v *string) string {
		if v == nil {
			return ""
		}
		return *v
	}
	if version != Version3 {
		if c.SNMPCommunity == nil {
			return SNMPDevice{}, errors.New("interface poll has no community")
		}
		device.Auth.Community = *c.SNMPCommunity
		return device, nil
	}
	device.Auth.Username = *c.SNMP.Username
	if c.SNMP.AuthProtocol != nil {
		if c.SNMPAuthPassphrase == nil {
			return SNMPDevice{}, errors.New("interface poll has no authentication passphrase")
		}
		device.Auth.AuthProtocol, device.Auth.AuthPassphrase = pollAuthProtocols[*c.SNMP.AuthProtocol], secret(c.SNMPAuthPassphrase)
	}
	if c.SNMP.PrivProtocol != nil {
		if c.SNMPPrivPassphrase == nil {
			return SNMPDevice{}, errors.New("interface poll has no privacy passphrase")
		}
		device.Auth.PrivProtocol, device.Auth.PrivPassphrase = pollPrivProtocols[*c.SNMP.PrivProtocol], secret(c.SNMPPrivPassphrase)
	}
	device.Auth.SecurityLevel = inferSecurityLevel(device.Auth)
	return device, nil
}

// Request is the bounded collection request for this command.
func (c *InterfacePollCommandV1) Request(deadline time.Time) InterfaceMetricRequest {
	return InterfaceMetricRequest{Version: pollVersions[c.SNMP.Version], Interfaces: c.Interfaces, Deadline: deadline}
}

// Envelope answers the command. started/finished bound every sample.
func (c *InterfacePollCommandV1) Envelope(commandID string, started, finished time.Time, snap InterfaceMetricSnapshot) InterfaceMetricEnvelopeV1 {
	stamp := func(t time.Time) string { return t.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z") }
	samples := snap.Samples
	if samples == nil {
		samples = []InterfaceMetricSampleV1{}
	}
	id := commandID
	return InterfaceMetricEnvelopeV1{SchemaVersion: InterfaceMetricsSchemaVersion, Family: InterfaceMetricsFamily, ProducerEpoch: c.ProducerEpoch,
		Sequence: c.Sequence, CommandID: &id, ConfigurationRevision: c.ConfigurationRevision, StartedAt: stamp(started),
		FinishedAt: stamp(finished.Add(time.Millisecond - 1)), ExpectedIntervalSeconds: c.ExpectedIntervalSeconds, Outcome: snap.Outcome,
		ReasonCode: snap.ReasonCode, Samples: samples}
}
