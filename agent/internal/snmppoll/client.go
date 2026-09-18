package snmppoll

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

// SNMPVersion separates an unset version from SNMPv1 (zero in gosnmp).
type SNMPVersion string

const (
	Version1  SNMPVersion = "1"
	Version2c SNMPVersion = "2c"
	Version3  SNMPVersion = "3"
)

func (v SNMPVersion) goSNMPVersion() (gosnmp.SnmpVersion, error) {
	switch v {
	case Version1:
		return gosnmp.Version1, nil
	case Version2c:
		return gosnmp.Version2c, nil
	case Version3:
		return gosnmp.Version3, nil
	default:
		return 0, fmt.Errorf("unsupported SNMP version %q", v)
	}
}

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

// NewClient creates and connects an SNMP client for v1, v2c or v3.
func NewClient(config SNMPClientConfig) (*SNMPClient, error) {
	config = normalizeClientConfig(config)
	if config.Target == "" {
		return nil, errors.New("SNMP target is required")
	}

	version, err := config.Version.goSNMPVersion()
	if err != nil {
		return nil, err
	}

	gs := &gosnmp.GoSNMP{
		Target:         config.Target,
		Port:           config.Port,
		Version:        version,
		Timeout:        config.Timeout,
		Retries:        config.Retries,
		MaxRepetitions: config.MaxRepetitions,
	}

	gs.Logger = gosnmp.NewLogger(snmpDebugLogger{})

	switch config.Version {
	case Version3:
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

// GetMulti fetches multiple OIDs in a single GET request.
func (c *SNMPClient) GetMulti(oids []string) ([]gosnmp.SnmpPDU, error) {
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

// Walk returns every PDU in the subtree rooted at rootOID.
// It uses GETNEXT for v1 and GETBULK for v2c/v3.
func (c *SNMPClient) Walk(rootOID string) ([]gosnmp.SnmpPDU, error) {
	if rootOID == "" {
		return nil, errors.New("root OID is required")
	}
	if c == nil || c.client == nil {
		return nil, errors.New("SNMP client is not connected")
	}
	walk := c.client.BulkWalkAll
	if c.client.Version == gosnmp.Version1 {
		walk = c.client.WalkAll
	}
	pdus, err := walk(rootOID)
	if err != nil {
		return nil, fmt.Errorf("SNMP walk of %s failed: %w", rootOID, err)
	}
	return pdus, nil
}

// BulkWalk returns all subtree PDUs using GETBULK, or GETNEXT for v1.
func (c *SNMPClient) BulkWalk(rootOID string) ([]gosnmp.SnmpPDU, error) {
	if rootOID == "" {
		return nil, errors.New("oid is required")
	}
	if c == nil || c.client == nil {
		return nil, errors.New("SNMP client is not connected")
	}
	walk := c.client.BulkWalkAll
	if c.client.Version == gosnmp.Version1 {
		walk = c.client.WalkAll
	}
	pdus, err := walk(rootOID)
	if err != nil {
		return nil, err
	}
	return pdus, nil
}

func normalizeClientConfig(config SNMPClientConfig) SNMPClientConfig {
	if config.Port == 0 {
		config.Port = 161
	}
	if config.Version == "" {
		config.Version = Version2c
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

	if config.Version == Version3 {
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

// ParseAuthProtocol converts a string (e.g. "SHA", "MD5") to a gosnmp auth protocol.
func ParseAuthProtocol(s string) gosnmp.SnmpV3AuthProtocol {
	switch strings.ToUpper(s) {
	case "MD5":
		return gosnmp.MD5
	case "SHA", "SHA1":
		return gosnmp.SHA
	case "SHA224":
		return gosnmp.SHA224
	case "SHA256":
		return gosnmp.SHA256
	case "SHA384":
		return gosnmp.SHA384
	case "SHA512":
		return gosnmp.SHA512
	default:
		return gosnmp.NoAuth
	}
}

// ParsePrivProtocol converts a string (e.g. "AES", "DES") to a gosnmp priv protocol.
func ParsePrivProtocol(s string) gosnmp.SnmpV3PrivProtocol {
	switch strings.ToUpper(s) {
	case "DES":
		return gosnmp.DES
	case "AES", "AES128":
		return gosnmp.AES
	case "AES192":
		return gosnmp.AES192
	case "AES256":
		return gosnmp.AES256
	case "AES192C":
		return gosnmp.AES192C
	case "AES256C":
		return gosnmp.AES256C
	default:
		return gosnmp.NoPriv
	}
}

// WalkBounded streams a GETBULK walk (GETNEXT for v1), calling fn for each PDU, and
// stops the moment fn returns an error.
//
// Deliberately NOT BulkWalkAll (which Walk and BulkWalk above use): BulkWalkAll
// buffers the entire subtree before returning, so a caller that wants to cap
// rows, bytes or wall clock has already paid all three by the time it can look.
// A bound that only applies after the fact bounds nothing, and this walks
// customer hardware — an FDB table on a busy switch is unbounded in practice.
func (c *SNMPClient) WalkBounded(rootOID string, fn gosnmp.WalkFunc) error {
	if rootOID == "" {
		return errors.New("oid is required")
	}
	if c == nil || c.client == nil {
		return errors.New("SNMP client is not connected")
	}
	if fn == nil {
		return errors.New("walk callback is required")
	}
	if c.client.Version == gosnmp.Version1 {
		return walkNextPages(rootOID, fn, c.client.GetNext)
	}
	return walkBulkPages(rootOID, fn, c.client.GetBulk, c.client.MaxRepetitions)
}

func walkNextPages(rootOID string, fn gosnmp.WalkFunc, getNext func([]string) (*gosnmp.SnmpPacket, error)) error {
	return walkBulkPages(rootOID, fn, func(oids []string, _ uint8, _ uint32) (*gosnmp.SnmpPacket, error) {
		packet, err := getNext(oids)
		// SNMPv1 signals end-of-MIB with NoSuchName instead of EndOfMibView.
		if err == nil && packet != nil && packet.Error == gosnmp.NoSuchName {
			return &gosnmp.SnmpPacket{}, nil
		}
		return packet, err
	}, 1)
}

// SnmpStatusError preserves an agent's protocol-level refusal to complete a walk.
type SnmpStatusError struct {
	Status gosnmp.SNMPError
	Index  uint8
}

func (e *SnmpStatusError) Error() string {
	return fmt.Sprintf("SNMP status %s at index %d", e.Status, e.Index)
}

type snmpDebugLogger struct{}

func (snmpDebugLogger) Print(v ...any)                 { slog.Debug(fmt.Sprint(v...)) }
func (snmpDebugLogger) Printf(format string, v ...any) { slog.Debug(fmt.Sprintf(format, v...)) }

// walkBulkPages keeps the page transport injectable for tests without a socket.
// gosnmp's BulkWalk treats SNMP error statuses as successful completion.
func walkBulkPages(rootOID string, fn gosnmp.WalkFunc, getBulk func([]string, uint8, uint32) (*gosnmp.SnmpPacket, error), maxRepetitions uint32) error {
	root := normalizeOID(rootOID)
	cursor := root
	if maxRepetitions == 0 {
		maxRepetitions = 10
	}
	for {
		packet, err := getBulk([]string{cursor}, 0, maxRepetitions)
		if err != nil {
			return err
		}
		if packet == nil {
			return errors.New("SNMP response was empty")
		}
		if packet.Error != gosnmp.NoError {
			return &SnmpStatusError{Status: packet.Error, Index: packet.ErrorIndex}
		}
		if len(packet.Variables) == 0 {
			return nil
		}
		for _, pdu := range packet.Variables {
			if pdu.Type == gosnmp.EndOfMibView || pdu.Type == gosnmp.NoSuchObject || pdu.Type == gosnmp.NoSuchInstance {
				return nil
			}
			oid := normalizeOID(pdu.Name)
			if !strings.HasPrefix(oid, root+".") {
				return nil
			}
			if !oidIncreases(cursor, oid) {
				return fmt.Errorf("OID not increasing: %s >= %s", cursor, oid)
			}
			if err := fn(pdu); err != nil {
				return err
			}
			cursor = oid
		}
	}
}

// Compare arcs numerically: instance 10 follows instance 9.
func oidIncreases(previous, next string) bool {
	a, b := strings.Split(previous, "."), strings.Split(next, ".")
	for i := 0; i < len(a) && i < len(b); i++ {
		av, ae := strconv.ParseUint(a[i], 10, 32)
		bv, be := strconv.ParseUint(b[i], 10, 32)
		if ae != nil || be != nil {
			return false
		}
		if av != bv {
			return av < bv
		}
	}
	return len(a) < len(b)
}
