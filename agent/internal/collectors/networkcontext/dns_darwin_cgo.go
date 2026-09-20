//go:build darwin && cgo

package networkcontext

/*
#cgo LDFLAGS: -framework SystemConfiguration -framework CoreFoundation
#include <SystemConfiguration/SystemConfiguration.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
// Return the dynamic-store DNS/service snapshot as XML; Go parses bounded
// structured data rather than localized command output on cgo builds.
static CFDataRef topologyDNS(void) {
 SCDynamicStoreRef store=SCDynamicStoreCreate(NULL,CFSTR("Breeze topology passive DNS"),NULL,NULL);
 if (!store) return NULL;
 const void *patterns[]={CFSTR("State:/Network/Service/.+/DNS"),CFSTR("State:/Network/Service/.+/IPv4"),CFSTR("State:/Network/Service/.+/IPv6")};
 CFArrayRef keys=CFArrayCreate(NULL,patterns,3,&kCFTypeArrayCallBacks);
 CFDictionaryRef values=SCDynamicStoreCopyMultiple(store,NULL,keys);
 CFRelease(keys); CFRelease(store);
 if (!values) return NULL;
 CFDataRef data=CFPropertyListCreateData(NULL,values,kCFPropertyListXMLFormat_v1_0,0,NULL);
 CFRelease(values);return data;
}
*/
import "C"
import (
	"bytes"
	"context"
	"encoding/xml"
	"io"
	"net/netip"
	"strings"
	"unsafe"
)

func plistValue(d *xml.Decoder, start xml.StartElement) (any, error) {
	switch start.Name.Local {
	case "dict":
		out := map[string]any{}
		var key string
		for {
			token, e := d.Token()
			if e != nil {
				return nil, e
			}
			switch v := token.(type) {
			case xml.EndElement:
				if v.Name == start.Name {
					return out, nil
				}
			case xml.StartElement:
				if v.Name.Local == "key" {
					if e := d.DecodeElement(&key, &v); e != nil {
						return nil, e
					}
				} else {
					x, e := plistValue(d, v)
					if e != nil {
						return nil, e
					}
					out[key] = x
				}
			}
		}
	case "array":
		out := []any{}
		for {
			token, e := d.Token()
			if e != nil {
				return nil, e
			}
			switch v := token.(type) {
			case xml.EndElement:
				if v.Name == start.Name {
					return out, nil
				}
			case xml.StartElement:
				x, e := plistValue(d, v)
				if e != nil {
					return nil, e
				}
				out = append(out, x)
			}
		}
	default:
		var value string
		e := d.DecodeElement(&value, &start)
		return value, e
	}
}
func readNativeDNS(ctx context.Context) (ResolverSection, error) {
	if e := ctx.Err(); e != nil {
		return ResolverSection{}, e
	}
	data := C.topologyDNS()
	if data == 0 {
		return ResolverSection{}, ErrMalformed
	}
	defer C.CFRelease(C.CFTypeRef(data))
	count := C.CFDataGetLength(data)
	if count > 1024*1024 {
		return ResolverSection{}, ErrLimit
	}
	raw := C.GoBytes(unsafe.Pointer(C.CFDataGetBytePtr(data)), C.int(count))
	return parseSystemConfigurationDNS(raw)
}
func parseSystemConfigurationDNS(raw []byte) (ResolverSection, error) {
	out := ResolverSection{Outcome: Complete, Rows: []ResolverRow{}}
	d := xml.NewDecoder(bytes.NewReader(raw))
	var values map[string]any
	for {
		token, e := d.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			return out, e
		}
		if start, ok := token.(xml.StartElement); ok && start.Name.Local == "dict" {
			v, e := plistValue(d, start)
			if e != nil {
				return out, e
			}
			values = v.(map[string]any)
			break
		}
	}
	if values == nil {
		return out, ErrMalformed
	}
	for key, value := range values {
		if !strings.HasSuffix(key, "/DNS") {
			continue
		}
		dns, ok := value.(map[string]any)
		if !ok {
			out.Outcome = Partial
			continue
		}
		base := strings.TrimSuffix(key, "/DNS")
		var iface *string
		for _, kind := range []string{"/IPv4", "/IPv6"} {
			if state, ok := values[base+kind].(map[string]any); ok {
				if name, ok := state["InterfaceName"].(string); ok {
					iface = ptr("darwin-ifname:" + name)
				}
			}
		}
		domains := []Domain{}
		for _, field := range []string{"SearchDomains", "SupplementalMatchDomains"} {
			if list, ok := dns[field].([]any); ok {
				for _, v := range list {
					if name, ok := v.(string); ok && name != "" {
						domains = append(domains, Domain{Name: name, RouteOnly: field == "SupplementalMatchDomains"})
					}
				}
			}
		}
		servers, ok := dns["ServerAddresses"].([]any)
		if !ok {
			out.Outcome = Partial
			continue
		}
		for _, value := range servers {
			text, ok := value.(string)
			if !ok {
				out.Outcome = Partial
				continue
			}
			ip, e := netip.ParseAddr(text)
			if e != nil {
				out.Outcome = Partial
				continue
			}
			var zone *string
			if ip.Is6() && ip.IsLinkLocalUnicast() {
				zone = iface
				if zone == nil {
					out.Outcome = Partial
					continue
				}
			}
			row := ResolverRow{Address: ip.WithZone("").String(), Zone: zone, InterfaceKey: iface, IsLocalStub: ip.IsLoopback(), Port: 53, Transport: "udp_tcp", Domains: domains, Mechanism: "system_configuration"}
			row.RowKey = rowIdentity(row)
			out.Rows = append(out.Rows, row)
		}
	}
	if out.Outcome == Partial {
		out.ReasonCode = "resolver_scope_unknown"
	}
	out.RowCount = len(out.Rows)
	return out, nil
}
