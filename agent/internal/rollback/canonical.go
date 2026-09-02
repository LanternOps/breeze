package rollback

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

const canonicalDomain = "breeze-agent-rollback-directive-v1"

func canonicalJSON(value any) ([]byte, error) {
	var out bytes.Buffer
	if err := appendCanonicalJSON(&out, reflect.ValueOf(value)); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func appendCanonicalJSON(out *bytes.Buffer, value reflect.Value) error {
	if !value.IsValid() {
		out.WriteString("null")
		return nil
	}
	if value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			out.WriteString("null")
			return nil
		}
		return appendCanonicalJSON(out, value.Elem())
	}
	switch value.Kind() {
	case reflect.Struct:
		fields := make(map[string]reflect.Value)
		typ := value.Type()
		for i := 0; i < value.NumField(); i++ {
			name := strings.Split(typ.Field(i).Tag.Get("json"), ",")[0]
			if name != "" && name != "-" {
				fields[name] = value.Field(i)
			}
		}
		keys := make([]string, 0, len(fields))
		for key := range fields {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			encoded, _ := json.Marshal(key)
			out.Write(encoded)
			out.WriteByte(':')
			if err := appendCanonicalJSON(out, fields[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	case reflect.Map:
		if value.Type().Key().Kind() != reflect.String {
			return fmt.Errorf("canonical JSON map key is not a string")
		}
		keys := value.MapKeys()
		sort.Slice(keys, func(i, j int) bool { return keys[i].String() < keys[j].String() })
		out.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			encoded, _ := json.Marshal(key.String())
			out.Write(encoded)
			out.WriteByte(':')
			if err := appendCanonicalJSON(out, value.MapIndex(key)); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	case reflect.Slice, reflect.Array:
		out.WriteByte('[')
		for i := 0; i < value.Len(); i++ {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := appendCanonicalJSON(out, value.Index(i)); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case reflect.String:
		encoded, _ := json.Marshal(value.String())
		out.Write(encoded)
	case reflect.Bool:
		out.WriteString(strconv.FormatBool(value.Bool()))
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		out.WriteString(strconv.FormatInt(value.Int(), 10))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		out.WriteString(strconv.FormatUint(value.Uint(), 10))
	case reflect.Float32, reflect.Float64:
		out.WriteString(strconv.FormatFloat(value.Float(), 'g', -1, value.Type().Bits()))
	default:
		return fmt.Errorf("unsupported canonical JSON type %s", value.Kind())
	}
	return nil
}

func digestHex(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }

func CanonicalBytes(d Directive) ([]byte, error) {
	if d.SchemaVersion != 1 {
		return nil, fmt.Errorf("unsupported rollback directive schema")
	}
	if err := rejectLineSeparators(reflect.ValueOf(d)); err != nil {
		return nil, err
	}
	for field, value := range map[string]string{"approvedAt": d.ApprovedAt, "expiresAt": d.ExpiresAt} {
		parsed, err := time.Parse("2006-01-02T15:04:05Z", value)
		if err != nil || parsed.Format("2006-01-02T15:04:05Z") != value {
			return nil, fmt.Errorf("%s must be a second-precision UTC timestamp", field)
		}
	}
	components, err := canonicalJSON(d.ComponentVersions)
	if err != nil {
		return nil, err
	}
	artifacts, err := canonicalJSON(d.Artifacts)
	if err != nil {
		return nil, err
	}
	lines := []string{canonicalDomain, d.RollbackID, d.DeviceID, d.OrgID, d.Platform, d.Architecture, d.CurrentVersion, d.TargetVersion, digestHex(components), digestHex([]byte(d.ReleaseManifest)), d.ManifestSignature, d.ManifestSigningKeyID, digestHex(artifacts), digestHex([]byte(d.Reason)), d.AuthorizedBy, d.ApprovedAt, d.ExpiresAt, d.DirectiveSigningKeyID}
	for _, line := range lines {
		if strings.ContainsAny(line, "\r\n") {
			return nil, fmt.Errorf("rollback directive field contains a newline")
		}
	}
	return []byte(strings.Join(lines, "\n")), nil
}

func rejectLineSeparators(value reflect.Value) error {
	if !value.IsValid() {
		return nil
	}
	if value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil
		}
		return rejectLineSeparators(value.Elem())
	}
	switch value.Kind() {
	case reflect.String:
		if strings.ContainsAny(value.String(), "\r\n") {
			return fmt.Errorf("rollback directive field contains a newline")
		}
	case reflect.Struct:
		for i := 0; i < value.NumField(); i++ {
			if err := rejectLineSeparators(value.Field(i)); err != nil {
				return err
			}
		}
	case reflect.Map:
		iter := value.MapRange()
		for iter.Next() {
			if err := rejectLineSeparators(iter.Key()); err != nil {
				return err
			}
			if err := rejectLineSeparators(iter.Value()); err != nil {
				return err
			}
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < value.Len(); i++ {
			if err := rejectLineSeparators(value.Index(i)); err != nil {
				return err
			}
		}
	}
	return nil
}

func DirectiveDigest(d Directive) (string, error) {
	payload, err := CanonicalBytes(d)
	if err != nil {
		return "", err
	}
	return digestHex(payload), nil
}
