package hwhealth

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var errNoBMC = errors.New("BMC unavailable")
var bmcPair = regexp.MustCompile(`(?m)^\s*([^\r\n:=]+?)\s*[:=]\s*([^\r\n]*)`)

func bmcUnavailable(raw []byte) bool {
	s := strings.ToLower(string(raw))
	for _, phrase := range []string{"no bmc found", "could not open device at /dev/ipmi", "unable to communicate with idrac", "no ilo management processor found", "ipmi driver is not installed"} {
		if strings.Contains(s, phrase) {
			return true
		}
	}
	return false
}

// parseBMC extracts a small allowlist of BMC facts (ip, mac, firmware, vendor-derived name)
// from vendor-specific text or XML captures. Safety here rests entirely on only ever reading
// the allowlisted keys (ip/mac/vendor/firmware) that these specific commands can produce — it
// does not inspect or sanitize the raw export for credential material, so it must never be
// extended to a command or key set that could carry secrets (e.g. hponcfg RIBCL LOGIN/PASSWORD
// attributes are present in some exports but are never read here).
func parseBMC(kind Kind, network, info []byte) (Component, error) {
	if len(network)+len(info) > 4*1024*1024 {
		return Component{}, errors.New("BMC output exceeds 4 MB")
	}
	if bmcUnavailable(network) || bmcUnavailable(info) {
		return Component{}, errNoBMC
	}
	values := map[string]string{}
	if kind == "hponcfg" {
		dec := xml.NewDecoder(bytes.NewReader(network))
		root := false
		for {
			tok, err := dec.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				return Component{}, errors.New("invalid BMC XML")
			}
			if start, ok := tok.(xml.StartElement); ok {
				key := strings.ToUpper(start.Name.Local)
				if key == "RIBCL" {
					root = true
				}
				if key == "IP_ADDRESS" || key == "MAC_ADDRESS" || key == "FIRMWARE_VERSION" || key == "FWRI" {
					for _, a := range start.Attr {
						if strings.EqualFold(a.Name.Local, "VALUE") {
							values[key] = strings.TrimSpace(a.Value)
						}
					}
				}
			}
		}
		if !root {
			return Component{}, errors.New("missing RIBCL root")
		}
	} else {
		raw := append(append([]byte{}, network...), '\n')
		raw = append(raw, info...)
		for _, pair := range bmcPair.FindAllSubmatch(raw, -1) {
			values[strings.ToLower(strings.TrimSpace(string(pair[1])))] = strings.TrimSpace(string(pair[2]))
		}
	}
	ip, mac, fw, vendor, name := "", "", "", "", "BMC"
	switch kind {
	case "ipmi":
		ip, mac, fw, vendor = values["ip address"], values["mac address"], values["firmware revision"], values["manufacturer name"]
		switch {
		case strings.Contains(strings.ToLower(vendor), "dell"):
			name = "iDRAC"
		case strings.Contains(strings.ToLower(vendor), "hewlett"), strings.Contains(strings.ToLower(vendor), "hpe"):
			name = "iLO"
		case strings.Contains(strings.ToLower(vendor), "lenovo"):
			name = "XClarity Controller"
		}
	case "racadm":
		ip, mac, fw, vendor, name = values["ip address"], values["mac address"], values["idrac version"], "Dell", "iDRAC"
	case "hponcfg":
		ip, mac, fw, vendor, name = values["IP_ADDRESS"], values["MAC_ADDRESS"], values["FIRMWARE_VERSION"], "HPE", "iLO"
		if fw == "" {
			fw = values["FWRI"]
		}
		if fw == "" {
			for _, pair := range bmcPair.FindAllSubmatch(info, -1) {
				if strings.EqualFold(strings.TrimSpace(string(pair[1])), "Firmware Revision") {
					fw = strings.TrimSpace(string(pair[2]))
				}
			}
		}
	default:
		return Component{}, fmt.Errorf("unsupported BMC source %s", kind)
	}
	if ip == "" && mac == "" && fw == "" {
		return Component{}, errors.New("BMC facts missing")
	}
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil || parsedIP.IsUnspecified() || parsedIP.IsMulticast() {
		ip = ""
	} else {
		ip = parsedIP.String()
	}
	parsedMAC, err := net.ParseMAC(mac)
	if err != nil || len(parsedMAC) != 6 || parsedMAC[0]&1 != 0 || bytes.Equal(parsedMAC, make([]byte, 6)) {
		mac = ""
	} else {
		mac = parsedMAC.String()
	}
	c := Component{
		ComponentType: "bmc",
		ComponentKey:  "bmc:" + string(kind),
		Source:        kind,
		Name:          name,
		State:         "ok",
		Attributes:    map[string]any{"ip": ip, "mac": mac, "vendor": vendor},
	}
	if fw != "" {
		c.Firmware = ptr(fw)
	}
	return c, nil
}

// newBMC builds a Source that runs a bounded set of read-only BMC inspection commands
// (ipmitool/racadm/hponcfg) and turns their output into a single "bmc" Component via
// parseBMC. No credential material is ever passed to these tools, and the hponcfg
// private export is always removed, on both the success and failure paths.
func newBMC(kind Kind, extra []string, run toolRunner) Source {
	return &source{
		kind: kind,
		tier: TierRAID,
		detect: func(context.Context) Availability {
			p, ok := lookupTool(bmcToolNames(kind), extra)
			return Availability{Path: p, Available: ok}
		},
		collect: func(parent context.Context, a Availability) (Result, error) {
			ctx, cancel := context.WithTimeout(parent, 20*time.Second)
			defer cancel()
			query := func(args ...string) ([]byte, error) {
				out, err := run(ctx, 20*time.Second, a.Path, args...)
				if err != nil {
					return nil, fmt.Errorf("BMC command failed: %w", err)
				}
				if out.Truncated {
					return nil, errors.New("BMC output truncated")
				}
				if bmcUnavailable(out.Stdout) || bmcUnavailable(out.Stderr) {
					return nil, errNoBMC
				}
				if out.ExitCode != 0 {
					return nil, fmt.Errorf("BMC command exit %d", out.ExitCode)
				}
				return out.Stdout, nil
			}
			var network, info []byte
			var err error
			switch kind {
			case "ipmi":
				network, err = query("lan", "print", "1")
				if err == nil {
					info, err = query("mc", "info")
				}
			case "racadm":
				network, err = query("getniccfg")
				if err == nil {
					info, err = query("getversion")
				}
			case "hponcfg":
				dir, e := os.MkdirTemp("", "breeze-bmc-")
				if e != nil {
					return Result{}, e
				}
				defer func() { _ = os.RemoveAll(dir) }()
				path := filepath.Join(dir, "ribcl.xml")
				info, err = query("-w", path)
				if err == nil {
					f, openErr := os.Open(path)
					if openErr != nil {
						return Result{}, errors.New("BMC export not readable")
					}
					network, err = io.ReadAll(io.LimitReader(f, 4*1024*1024+1))
					if closeErr := f.Close(); closeErr != nil && err == nil {
						err = closeErr
					}
				}
			default:
				return Result{}, fmt.Errorf("unsupported BMC source %s", kind)
			}
			if err != nil {
				return Result{}, err
			}
			c, err := parseBMC(kind, network, info)
			if err != nil {
				return Result{}, err
			}
			return Result{Components: []Component{c}, Complete: true}, nil
		},
	}
}
