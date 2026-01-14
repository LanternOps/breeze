package snmp

import (
	"errors"
	"fmt"
	"time"

	"github.com/gosnmp/gosnmp"
)

// SNMPVersion exposes gosnmp's version type for callers.
type SNMPVersion = gosnmp.SnmpVersion

// SNMPAuth holds SNMP v2c community or v3 authentication parameters.
type SNMPAuth struct {
	Community      string
	Username       string
	AuthProtocol   gosnmp.SnmpV3AuthProtocol
	AuthPassphrase string
	PrivProtocol   gosnmp.SnmpV3PrivProtocol
	PrivPassphrase string
	SecurityLevel  gosnmp.SnmpV3MsgFlags
}

// SNMPClientConfig defines connection settings for an SNMP client.
type SNMPClientConfig struct {
	Target         string
	Port           uint16
	Version        SNMPVersion
	Auth           SNMPAuth
	Timeout        time.Duration
	Retries        int
	MaxRepetitions uint32
}

// SNMPClient wraps gosnmp with helper methods.
type SNMPClient struct {
	client *gosnmp.GoSNMP
}

// NewClient creates and connects an SNMP client for v2c or v3.
func NewClient(config SNMPClientConfig) (*SNMPClient, error) {
	config = normalizeClientConfig(config)
	if config.Target == "" {
		return nil, errors.New("SNMP target is required")
	}

	gs := &gosnmp.GoSNMP{
		Target:         config.Target,
		Port:           config.Port,
		Version:        config.Version,
		Timeout:        config.Timeout,
		Retries:        config.Retries,
		MaxRepetitions: config.MaxRepetitions,
	}

	switch config.Version {
	case gosnmp.Version3:
		if config.Auth.Username == "" {
			return nil, errors.New("SNMP v3 username is required")
		}
		gs.SecurityModel = gosnmp.UserSecurityModel
		gs.MsgFlags = config.Auth.SecurityLevel
		gs.SecurityParameters = &gosnmp.UsmSecurityParameters{
			UserName:                 config.Auth.Username,
			AuthenticationProtocol:   config.Auth.AuthProtocol,
			AuthenticationPassphrase: config.Auth.AuthPassphrase,
			PrivacyProtocol:          config.Auth.PrivProtocol,
			PrivacyPassphrase:        config.Auth.PrivPassphrase,
		}
	default:
		gs.Community = config.Auth.Community
	}

	if err := gs.Connect(); err != nil {
		return nil, fmt.Errorf("SNMP connect failed: %w", err)
	}

	return &SNMPClient{client: gs}, nil
}

// Close releases the underlying connection.
func (c *SNMPClient) Close() {
	if c == nil || c.client == nil || c.client.Conn == nil {
		return
	}
	_ = c.client.Conn.Close()
}

// Get fetches a single OID.
func (c *SNMPClient) Get(oid string) (gosnmp.SnmpPDU, error) {
	if oid == "" {
		return gosnmp.SnmpPDU{}, errors.New("oid is required")
	}
	packet, err := c.client.Get([]string{oid})
	if err != nil {
		return gosnmp.SnmpPDU{}, err
	}
	if packet == nil || len(packet.Variables) == 0 {
		return gosnmp.SnmpPDU{}, errors.New("SNMP response contained no variables")
	}
	return packet.Variables[0], nil
}

// GetBulk fetches multiple OIDs in a single request.
func (c *SNMPClient) GetBulk(oids []string) ([]gosnmp.SnmpPDU, error) {
	if len(oids) == 0 {
		return nil, nil
	}
	packet, err := c.client.Get(oids)
	if err != nil {
		return nil, err
	}
	if packet == nil {
		return nil, errors.New("SNMP response was empty")
	}
	return packet.Variables, nil
}

// Walk retrieves all OIDs under the provided base OID.
func (c *SNMPClient) Walk(oid string) ([]gosnmp.SnmpPDU, error) {
	if oid == "" {
		return nil, errors.New("oid is required")
	}

	var results []gosnmp.SnmpPDU
	err := c.client.Walk(oid, func(pdu gosnmp.SnmpPDU) error {
		results = append(results, pdu)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

func normalizeClientConfig(config SNMPClientConfig) SNMPClientConfig {
	if config.Port == 0 {
		config.Port = 161
	}
	if config.Version == 0 {
		config.Version = gosnmp.Version2c
	}
	if config.Timeout == 0 {
		config.Timeout = 2 * time.Second
	}
	if config.Retries == 0 {
		config.Retries = 1
	}
	if config.MaxRepetitions == 0 {
		config.MaxRepetitions = 10
	}

	if config.Version == gosnmp.Version3 {
		if config.Auth.SecurityLevel == 0 {
			config.Auth.SecurityLevel = inferSecurityLevel(config.Auth)
		}
		if config.Auth.AuthProtocol == 0 {
			config.Auth.AuthProtocol = gosnmp.NoAuth
		}
		if config.Auth.PrivProtocol == 0 {
			config.Auth.PrivProtocol = gosnmp.NoPriv
		}
	} else if config.Auth.Community == "" {
		config.Auth.Community = "public"
	}

	return config
}

func inferSecurityLevel(auth SNMPAuth) gosnmp.SnmpV3MsgFlags {
	if auth.PrivPassphrase != "" || auth.PrivProtocol != gosnmp.NoPriv {
		return gosnmp.AuthPriv
	}
	if auth.AuthPassphrase != "" || auth.AuthProtocol != gosnmp.NoAuth {
		return gosnmp.AuthNoPriv
	}
	return gosnmp.NoAuthNoPriv
}
