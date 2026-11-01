//go:build windows

package wfp

import (
	"fmt"
	"net/netip"
	"os"
	"runtime"
	"testing"
	"unsafe"
)

func TestSubscribeRejectsNoFilters(t *testing.T) {
	if _, _, err := SubscribeClassifyDrops(nil); err == nil {
		t.Fatal("empty subscription accepted")
	}
}
func liveSession(t *testing.T) *Session {
	t.Helper()
	if os.Getenv("BREEZE_WFP_TEST") != "1" {
		t.Skip("requires elevated disposable Windows host and BREEZE_WFP_TEST=1")
	}
	s, err := OpenSession()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	fs, err := s.EnumOwned()
	if err != nil {
		t.Fatal(err)
	}
	if len(fs) != 0 {
		t.Skip("refusing to touch existing isolation policy")
	}
	return s
}
func TestDeleteOwnedPreservesForeignObjects(t *testing.T) {
	s := liveSession(t)
	foreign, err := openSession(1)
	if err != nil {
		t.Fatal(err)
	}
	defer foreign.Close()
	provider := FilterKey("live-foreign-provider")
	sublayer := FilterKey("live-foreign-sublayer")
	filterKey := FilterKey("live-foreign-filter")
	err = foreign.Tx(func(tx *Tx) error {
		p, unpin, e := marshalProvider(provider, false)
		if e != nil {
			return e
		}
		defer unpin()
		if e = invoke(providerAdd, foreign.handle, uintptr(unsafe.Pointer(p)), 0); e != nil {
			return e
		}
		var pin runtime.Pinner
		defer pin.Unpin()
		pin.Pin(&provider)
		n := &nativeSublayer{Key: sublayer, Provider: &provider, Weight: 1}
		n.Display.Name, e = pinName(&pin, "Breeze isolation test foreign objects")
		if e != nil {
			return e
		}
		pin.Pin(n)
		if e = invoke(sublayerAdd, foreign.handle, uintptr(unsafe.Pointer(n)), 0); e != nil {
			return e
		}
		f := Filter{Key: filterKey, Name: "Foreign test permit", Layer: ALEConnectV4, Sublayer: sublayer, Action: Permit, Weight: 1, Conditions: []Condition{{Field: RemoteAddress, Address: netip.MustParsePrefix("192.0.2.0/24")}, {Field: RemotePort, Uint: 9}, {Field: Protocol, Uint: 6}}}
		m, e := marshalFilter(f)
		if e != nil {
			return e
		}
		defer m.pin.Unpin()
		m.filter.Provider = &provider
		var id uint64
		return invoke(filterAdd, foreign.handle, uintptr(unsafe.Pointer(m.filter)), 0, uintptr(unsafe.Pointer(&id)))
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Tx(func(tx *Tx) error { return tx.DeleteOwned() })
	err = s.Tx(func(tx *Tx) error {
		if e := tx.AddProvider(true); e != nil {
			return e
		}
		if e := tx.AddSublayer(SublayerWeight, true); e != nil {
			return e
		}
		for _, boot := range []bool{false, true} {
			_, e := tx.AddFilter(Filter{Key: FilterKey(fmt.Sprintf("live-owned-%v", boot)), Name: "Owned test permit", Layer: ALEConnectV4, Sublayer: SublayerKey, Weight: 1, Action: Permit, Persistent: !boot, BootTime: boot, Conditions: []Condition{{Field: RemoteAddress, Address: netip.MustParsePrefix("192.0.2.0/24")}, {Field: RemotePort, Uint: 9}, {Field: Protocol, Uint: 6}}})
			if e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	fs, err := s.EnumOwned()
	if err != nil {
		t.Fatal(err)
	}
	if len(fs) != 2 {
		t.Fatalf("owned count %d (boot-time must be included)", len(fs))
	}
	if err = s.Tx(func(tx *Tx) error { return tx.DeleteOwned() }); err != nil {
		t.Fatal(err)
	}
	fs, err = s.EnumOwned()
	if err != nil || len(fs) != 0 {
		t.Fatalf("remaining owned: %v %v", fs, err)
	}
	found := false
	err = foreign.enumRaw(func(f *nativeFilter) error {
		if f.Key == filterKey {
			found = true
			if f.Sublayer != sublayer || f.Provider == nil || *f.Provider != provider {
				t.Fatal("foreign ownership changed")
			}
		}
		return nil
	})
	if err != nil || !found {
		t.Fatalf("foreign filter disappeared: %v", err)
	}
}
func TestTransactionAbortsOnErrorAndPanic(t *testing.T) {
	s := liveSession(t)
	for _, panicCase := range []bool{false, true} {
		func() {
			defer func() {
				if got := recover(); panicCase && got == nil {
					t.Error("panic was swallowed")
				}
			}()
			err := s.Tx(func(tx *Tx) error {
				if e := tx.AddProvider(true); e != nil {
					return e
				}
				if panicCase {
					panic("expected transaction panic")
				}
				return fmt.Errorf("expected rollback")
			})
			if !panicCase && err == nil {
				t.Error("callback error lost")
			}
		}()
		if err := s.Tx(func(tx *Tx) error {
			if e := tx.AddProvider(true); e != nil {
				return e
			}
			return tx.DeleteOwned()
		}); err != nil {
			t.Fatalf("provider survived aborted transaction: %v", err)
		}
	}
}
