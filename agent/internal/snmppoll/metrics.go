package snmppoll

import (
	"errors"
	"math/big"
	"time"

	"github.com/gosnmp/gosnmp"
)

// SNMPDevice defines the target and credentials for polling.
type SNMPDevice struct {
	IP             string
	Port           uint16
	Version        SNMPVersion
	Auth           SNMPAuth
	OIDs           []string
	Timeout        time.Duration
	Retries        int
	MaxRepetitions uint32
}

// SNMPMetric represents a single SNMP value read.
type SNMPMetric struct {
	OID       string      `json:"oid"`
	Name      string      `json:"name"`
	Value     any `json:"value"`
	Timestamp time.Time   `json:"timestamp"`
}

// CollectMetrics fetches all configured OIDs for a device.
func CollectMetrics(device SNMPDevice) ([]SNMPMetric, error) {
	if device.IP == "" {
		return nil, errors.New("device IP is required")
	}
	if len(device.OIDs) == 0 {
		return nil, errors.New("device has no OIDs configured")
	}

	client, err := NewClient(device.ClientConfig())
	if err != nil {
		return nil, err
	}
	defer client.Close()

	pdus, err := getDevicePDUs(client, device.OIDs)
	if err != nil {
		return nil, err
	}

	metrics := make([]SNMPMetric, 0, len(pdus))
	stamp := time.Now().UTC()
	for _, pdu := range pdus {
		value := ParseValue(pdu)
		metric := SNMPMetric{
			OID:       pdu.Name,
			Name:      pdu.Name,
			Value:     value,
			Timestamp: stamp,
		}
		metrics = append(metrics, metric)
	}

	return metrics, nil
}

// ClientConfig converts an SNMPDevice into an SNMPClientConfig.
func (d SNMPDevice) ClientConfig() SNMPClientConfig {
	return SNMPClientConfig{
		Target:         d.IP,
		Port:           d.Port,
		Version:        d.Version,
		Auth:           d.Auth,
		Timeout:        d.Timeout,
		Retries:        d.Retries,
		MaxRepetitions: d.MaxRepetitions,
	}
}

// ParseValue converts SNMP PDUs into Go-friendly values.
func ParseValue(pdu gosnmp.SnmpPDU) any {
	if pdu.Value == nil {
		return nil
	}

	switch value := pdu.Value.(type) {
	case string:
		return value
	case []byte:
		return string(value)
	case *big.Int:
		if value.IsInt64() {
			return value.Int64()
		}
		if value.Sign() >= 0 && value.BitLen() <= 64 {
			return value.Uint64()
		}
		return value.String()
	default:
		bi := gosnmp.ToBigInt(value)
		if bi == nil {
			return nil
		}
		if bi.IsInt64() {
			return bi.Int64()
		}
		if bi.Sign() >= 0 && bi.BitLen() <= 64 {
			return bi.Uint64()
		}
		return bi.String()
	}
}

func getDevicePDUs(client *SNMPClient, oids []string) ([]gosnmp.SnmpPDU, error) {
	return client.GetMulti(oids)
}
