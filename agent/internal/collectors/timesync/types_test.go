package timesync

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestWireKeysAndNulls(t *testing.T) {
	s := emptySnapshot(time.Unix(1, 0).UTC())
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var root map[string]json.RawMessage
	if err = json.Unmarshal(b, &root); err != nil {
		t.Fatal(err)
	}
	keys := func(m map[string]json.RawMessage) []string {
		k := make([]string, 0, len(m))
		for n := range m {
			k = append(k, n)
		}
		sort.Strings(k)
		return k
	}
	want := strings.Fields("collectedAt config domain enforcement events schemaVersion sequence status timezone")
	if !reflect.DeepEqual(keys(root), want) {
		t.Fatal(string(b))
	}
	for field, expected := range map[string]string{"enforcement": "null", "events": "[]", "schemaVersion": "1"} {
		if string(root[field]) != expected {
			t.Fatalf("%s=%s", field, root[field])
		}
	}
	for field, expected := range map[string]string{
		"config":   "hostTimeProviderEnabled ntpServer policyManaged policyManagedValues serviceStartType serviceState specialPollIntervalSeconds type",
		"status":   "lastSuccessfulSyncAt lastSyncError method pollIntervalSeconds source sourceKind stratum",
		"domain":   "domainDns forestDns joinType pdcName role",
		"timezone": "autoUpdate biasMinutes dynamicDstDisabled windowsId",
	} {
		var nested map[string]json.RawMessage
		if err := json.Unmarshal(root[field], &nested); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(keys(nested), strings.Fields(expected)) {
			t.Fatalf("%s keys=%v", field, keys(nested))
		}
	}
	if strings.Contains(string(b), `:""`) {
		t.Fatal("unknown serialized as empty string")
	}
	var status map[string]json.RawMessage
	_ = json.Unmarshal(root["status"], &status)
	for _, name := range []string{"source", "lastSuccessfulSyncAt", "lastSyncError", "stratum", "pollIntervalSeconds"} {
		if string(status[name]) != "null" {
			t.Fatalf("%s not null", name)
		}
	}
}
