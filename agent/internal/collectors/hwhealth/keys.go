package hwhealth

import (
	"crypto/sha256"
	"fmt"
	"strings"
)

func controllerKey(k Kind, id string) string { return string(k) + ":c" + id }

func slotKey(c, e, s string) string {
	if e == "" {
		e = "-"
	}
	return c + ":e" + e + ":s" + s
}

func memberKey(v, id string) string { return v + ":m:" + id }

func objectHash(id string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(id)))[:24]
}

func smartKey(serial, deviceType, dev string, unique bool) string {
	serial = strings.TrimSpace(serial)
	if serial != "" && unique {
		return "smart:" + serial
	}
	return "smart:dev:" + deviceType + ":" + dev
}

func component(k Kind, typ ComponentType, key, parent, name, raw, state string) Component {
	c := Component{ComponentKey: key, ComponentType: typ, Source: k, Name: name, State: state, StateDetail: ptr(raw), Attributes: map[string]any{}}
	if parent != "" {
		c.ParentKey = ptr(parent)
	}
	return c
}
