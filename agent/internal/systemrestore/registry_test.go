package systemrestore

import (
	"errors"
	"testing"
)

func TestRegistryDisabled(t *testing.T) {
	denied := errors.New("access denied")
	tests := []struct {
		name    string
		values  map[string]any // "path|name" -> uint64 or error
		want    bool
		wantErr bool
	}{
		{"nothing set: enabled", map[string]any{}, false, false},
		{"policy DisableSR=1", map[string]any{srPolicyKey + "|DisableSR": uint64(1)}, true, false},
		{"config DisableSR=1", map[string]any{srConfigKey + "|DisableSR": uint64(1)}, true, false},
		{"DisableSR=0 everywhere", map[string]any{srPolicyKey + "|DisableSR": uint64(0), srConfigKey + "|DisableSR": uint64(0)}, false, false},
		{"unreadable policy value is an error, not enabled", map[string]any{srPolicyKey + "|DisableSR": denied}, false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			read := func(path, name string) (uint64, error) {
				v, ok := tc.values[path+"|"+name]
				if !ok {
					return 0, errRegistryNotExist
				}
				if err, isErr := v.(error); isErr {
					return 0, err
				}
				return v.(uint64), nil
			}
			got, err := registryDisabled(read)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("registryDisabled = (%v, %v), want (%v, err=%v)", got, err, tc.want, tc.wantErr)
			}
		})
	}
}

func TestRegistryFrequency(t *testing.T) {
	read := func(v uint64, err error) func(string, string) (uint64, error) {
		return func(string, string) (uint64, error) { return v, err }
	}
	if got, err := registryFrequency(read(0, errRegistryNotExist)); err != nil || got != defaultFrequencyMinutes {
		t.Fatalf("absent value = (%d, %v), want the Windows default", got, err)
	}
	if got, err := registryFrequency(read(60, nil)); err != nil || got != 60 {
		t.Fatalf("set value = (%d, %v), want 60", got, err)
	}
	if _, err := registryFrequency(read(0, errors.New("access denied"))); err == nil {
		t.Fatal("an unreadable value must be an error, not an invented default")
	}
}
