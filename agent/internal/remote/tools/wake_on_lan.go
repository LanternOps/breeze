package tools

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

const (
	wolMagicPacketLen = 102
	wolPacketRounds   = 3
	wolPacketGap      = 500 * time.Millisecond
)

// MagicPacket returns the 102-byte Wake-on-LAN magic packet for the given MAC:
// six 0xFF bytes followed by sixteen back-to-back copies of the MAC.
func MagicPacket(mac net.HardwareAddr) ([]byte, error) {
	if len(mac) != 6 {
		return nil, fmt.Errorf("MAC must be 6 bytes, got %d", len(mac))
	}
	pkt := make([]byte, wolMagicPacketLen)
	for i := 0; i < 6; i++ {
		pkt[i] = 0xFF
	}
	for i := 0; i < 16; i++ {
		copy(pkt[6+i*6:6+(i+1)*6], mac)
	}
	return pkt, nil
}

// parseMAC accepts the common formats: aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff,
// AABB.CCDD.EEFF. Returns the canonical net.HardwareAddr.
func parseMAC(s string) (net.HardwareAddr, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, errors.New("empty MAC")
	}
	mac, err := net.ParseMAC(s)
	if err != nil {
		return nil, fmt.Errorf("invalid MAC %q: %w", s, err)
	}
	if len(mac) != 6 {
		return nil, fmt.Errorf("MAC %q is not 6 bytes (got %d) — EUI-64 not supported", s, len(mac))
	}
	return mac, nil
}

// sendMagicPacket fires one magic-packet UDP write to broadcast:port.
// Directed subnet broadcast (computed from target's IP + mask, e.g.
// 192.168.1.255) is accepted by the kernel without SO_BROADCAST on Linux,
// macOS, and Windows. If a future field test shows otherwise, add a
// platform-split helper for SO_BROADCAST.
func sendMagicPacket(pkt []byte, broadcast net.IP, port int) error {
	conn, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: broadcast, Port: port})
	if err != nil {
		return fmt.Errorf("dial udp4 %s:%d: %w", broadcast, port, err)
	}
	defer conn.Close()

	if _, err := conn.Write(pkt); err != nil {
		return fmt.Errorf("write udp4 %s:%d: %w", broadcast, port, err)
	}
	return nil
}

func stringField(payload map[string]any, key string) (string, bool) {
	if payload == nil {
		return "", false
	}
	v, ok := payload[key]
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

func stringSliceField(payload map[string]any, key string) []string {
	if payload == nil {
		return nil
	}
	raw, ok := payload[key]
	if !ok {
		return nil
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func intSliceField(payload map[string]any, key string, defaults []int) []int {
	if payload == nil {
		return defaults
	}
	raw, ok := payload[key]
	if !ok {
		return defaults
	}
	arr, ok := raw.([]any)
	if !ok {
		return defaults
	}
	out := make([]int, 0, len(arr))
	for _, item := range arr {
		switch n := item.(type) {
		case float64:
			out = append(out, int(n))
		case int:
			out = append(out, n)
		case int64:
			out = append(out, int(n))
		}
	}
	if len(out) == 0 {
		return defaults
	}
	return out
}

// WakeOnLan sends magic packets to broadcast for each provided MAC across the
// requested UDP ports, repeating in 3 rounds spaced 500 ms apart. The command
// is considered successful if at least one packet was written without error.
func WakeOnLan(payload map[string]any) CommandResult {
	start := time.Now()

	broadcastStr, ok := stringField(payload, "broadcast")
	if !ok || broadcastStr == "" {
		return NewErrorResult(errors.New("payload.broadcast is required"), time.Since(start).Milliseconds())
	}
	broadcast := net.ParseIP(broadcastStr).To4()
	if broadcast == nil {
		return NewErrorResult(fmt.Errorf("payload.broadcast %q is not a valid IPv4 address", broadcastStr), time.Since(start).Milliseconds())
	}

	macStrings := stringSliceField(payload, "macs")
	if len(macStrings) == 0 {
		return NewErrorResult(errors.New("payload.macs must contain at least one MAC address"), time.Since(start).Milliseconds())
	}
	macs := make([]net.HardwareAddr, 0, len(macStrings))
	for _, s := range macStrings {
		mac, err := parseMAC(s)
		if err != nil {
			return NewErrorResult(err, time.Since(start).Milliseconds())
		}
		macs = append(macs, mac)
	}

	ports := intSliceField(payload, "ports", []int{7, 9})
	for _, p := range ports {
		if p < 1 || p > 65535 {
			return NewErrorResult(fmt.Errorf("invalid UDP port %d in payload.ports", p), time.Since(start).Milliseconds())
		}
	}

	type sendErr struct {
		mac  string
		port int
		err  string
	}
	var errs []sendErr
	sentOK := 0
	totalWrites := wolPacketRounds * len(macs) * len(ports)

	for round := 0; round < wolPacketRounds; round++ {
		for _, mac := range macs {
			pkt, err := MagicPacket(mac)
			if err != nil {
				errs = append(errs, sendErr{mac: mac.String(), err: err.Error()})
				continue
			}
			for _, port := range ports {
				if err := sendMagicPacket(pkt, broadcast, port); err != nil {
					errs = append(errs, sendErr{mac: mac.String(), port: port, err: err.Error()})
					continue
				}
				sentOK++
			}
		}
		if round < wolPacketRounds-1 {
			time.Sleep(wolPacketGap)
		}
	}

	wakeAttemptId, _ := stringField(payload, "wakeAttemptId")
	targetDeviceId, _ := stringField(payload, "targetDeviceId")

	if sentOK == 0 {
		err := errors.New("no magic packets could be sent")
		if len(errs) > 0 {
			err = fmt.Errorf("no magic packets could be sent; first failure: %s", errs[0].err)
		}
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	result := map[string]any{
		"wakeAttemptId":  wakeAttemptId,
		"targetDeviceId": targetDeviceId,
		"broadcast":      broadcast.String(),
		"ports":          ports,
		"macsAttempted":  macStrings,
		"packetsSent":    sentOK,
		"packetsTotal":   totalWrites,
	}
	if len(errs) > 0 {
		details := make([]map[string]any, 0, len(errs))
		for _, e := range errs {
			details = append(details, map[string]any{"mac": e.mac, "port": e.port, "error": e.err})
		}
		result["sendErrors"] = details
	}
	return NewSuccessResult(result, time.Since(start).Milliseconds())
}
