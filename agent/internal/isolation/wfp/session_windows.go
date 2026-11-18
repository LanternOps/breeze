//go:build windows

package wfp

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

// Session owns a non-dynamic BFE handle. Closing it never removes persistent policy.
// Operations serialize on the handle, because BFE permits one transaction per session.
type Session struct {
	mu     sync.Mutex
	handle uintptr
}

// OpenSession opens local BFE using the caller's identity and RPC_C_AUTHN_WINNT.
func OpenSession() (*Session, error) { return openSession(0) }
func openSession(flags uint32) (*Session, error) {
	var handle uintptr
	n := &nativeSession{Flags: flags}
	var pin runtime.Pinner
	pin.Pin(n)
	defer pin.Unpin()
	if err := invoke(engineOpen, 0, 10, 0, uintptr(unsafe.Pointer(n)), uintptr(unsafe.Pointer(&handle))); err != nil {
		return nil, err
	}
	return &Session{handle: handle}, nil
}

// Close closes the engine handle; repeated calls are harmless.
func (s *Session) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.handle == 0 {
		return nil
	}
	err := invoke(engineClose, s.handle)
	if err == nil {
		s.handle = 0
	}
	return err
}

// Tx scopes a transaction. Errors and panics abort; only a nil callback result commits.
func (s *Session) Tx(fn func(*Tx) error) (err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.handle == 0 {
		return fmt.Errorf("WFP session closed")
	}
	if err = invoke(txBegin, s.handle, 0); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			abortErr := invoke(txAbort, s.handle)
			if err != nil && abortErr != nil {
				err = errors.Join(err, abortErr)
			}
		}
	}()
	if err = fn(&Tx{session: s}); err != nil {
		return err
	}
	err = invoke(txCommit, s.handle)
	committed = err == nil
	return err
}

// Tx is valid only during Session.Tx's callback; it shares that session's lock.
type Tx struct{ session *Session }

// AddProvider registers Breeze without serviceName, so service startup policy
// cannot suppress isolation after BFE restarts (MS WFP Object Management).
func (t *Tx) AddProvider(persistent bool) error {
	p, unpin, err := marshalProvider(ProviderKey, persistent)
	if err != nil {
		return err
	}
	defer unpin()
	return invoke(providerAdd, t.session.handle, uintptr(unsafe.Pointer(p)), 0)
}

// AddSublayer creates the dedicated layer, owned by the same persistent provider.
func (t *Tx) AddSublayer(weight uint16, persistent bool) error {
	var pin runtime.Pinner
	defer pin.Unpin()
	p := new(GUID)
	*p = ProviderKey
	pin.Pin(p)
	n := &nativeSublayer{Key: SublayerKey, Provider: p, Weight: weight}
	if persistent {
		n.Flags = 1
	}
	name, err := pinName(&pin, ProviderName)
	if err != nil {
		return err
	}
	n.Display.Name = name
	pin.Pin(n)
	return invoke(sublayerAdd, t.session.handle, uintptr(unsafe.Pointer(n)), 0)
}

// AddFilter installs a validated rule with all nested native buffers pinned.
func (t *Tx) AddFilter(f Filter) (uint64, error) {
	m, err := marshalFilter(f)
	if err != nil {
		return 0, err
	}
	defer m.pin.Unpin()
	var id uint64
	err = invoke(filterAdd, t.session.handle, uintptr(unsafe.Pointer(m.filter)), 0, uintptr(unsafe.Pointer(&id)))
	runtime.KeepAlive(m)
	return id, err
}
func notFound(err error, code uint32) error {
	if errors.Is(err, syscall.Errno(code)) {
		return nil
	}
	return err
}

// DeleteOwned removes filters by key, including boot-time filters, before their
// dependencies. Enum includes disabled objects so capability-0 recovery is real.
// Foreign providers, sublayers and filters are never modified.
func (t *Tx) DeleteOwned() error {
	var keys []GUID
	if err := t.session.enumRaw(func(n *nativeFilter) error {
		if isOwned(n) {
			keys = append(keys, n.Key)
		}
		return nil
	}); err != nil {
		return err
	}
	for _, key := range keys {
		if err := notFound(invoke(filterDelete, t.session.handle, uintptr(unsafe.Pointer(&key))), 0x80320003); err != nil {
			return err
		}
	}
	if err := notFound(invoke(sublayerDelete, t.session.handle, uintptr(unsafe.Pointer(&SublayerKey))), 0x80320007); err != nil {
		return err
	}
	return notFound(invoke(providerDelete, t.session.handle, uintptr(unsafe.Pointer(&ProviderKey))), 0x80320005)
}
func isOwned(n *nativeFilter) bool {
	return n.Sublayer == SublayerKey || (n.Provider != nil && *n.Provider == ProviderKey)
}

// EnumOwned reads actual engine policy, including boot-time rules. Unknown native
// conditions fail verification rather than producing a reassuring partial digest.
func (s *Session) EnumOwned() ([]FilterInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var fs []FilterInfo
	err := s.enumRaw(func(n *nativeFilter) error {
		if !isOwned(n) {
			return nil
		}
		f, err := decodeFilter(n)
		if err != nil {
			return err
		}
		fs = append(fs, f)
		return nil
	})
	return fs, err
}
func (s *Session) enumRaw(visit func(*nativeFilter) error) error {
	if s.handle == 0 {
		return fmt.Errorf("WFP session closed")
	}
	layers, err := s.layerKeys()
	if err != nil {
		return err
	}
	for _, layer := range layers {
		if err := s.enumLayer(layer, visit); err != nil {
			return err
		}
	}
	return nil
}
func (s *Session) enumLayer(layer GUID, visit func(*nativeFilter) error) (err error) {
	if s.handle == 0 {
		return fmt.Errorf("WFP session closed")
	}
	// An explicit layer avoids relying on an undocumented zero-GUID wildcard.
	// INCLUDE_BOOTTIME | INCLUDE_DISABLED includes all object lifetimes.
	template := &nativeEnumTemplate{Layer: layer, Flags: 8 | 16, ActionMask: 0xffffffff}
	var pin runtime.Pinner
	pin.Pin(template)
	defer pin.Unpin()
	var h uintptr
	if err = invoke(enumCreate, s.handle, uintptr(unsafe.Pointer(template)), uintptr(unsafe.Pointer(&h))); err != nil {
		return err
	}
	defer func() { err = errors.Join(err, invoke(enumDestroy, s.handle, h)) }()
	for {
		var entries **nativeFilter
		var count uint32
		if err = invoke(enumFilters, s.handle, h, 256, uintptr(unsafe.Pointer(&entries)), uintptr(unsafe.Pointer(&count))); err != nil {
			return err
		}
		if entries == nil {
			if count != 0 {
				return fmt.Errorf("FwpmFilterEnum0 returned nil entries")
			}
			return nil
		}
		func() {
			defer free(unsafe.Pointer(entries))
			for _, n := range unsafe.Slice(entries, int(count)) {
				if n == nil {
					err = fmt.Errorf("FwpmFilterEnum0 returned nil filter")
					return
				}
				if e := visit(n); e != nil {
					err = e
					return
				}
			}
		}()
		if err != nil {
			return err
		}
		if count == 0 {
			return nil
		}
	}
}

// layerKeys enumerates the engine's layers instead of assuming this release's
// four ALE layers are the only places an older agent could have left objects.
func (s *Session) layerKeys() (keys []GUID, err error) {
	var handle uintptr
	if err = invoke(layerEnumCreate, s.handle, 0, uintptr(unsafe.Pointer(&handle))); err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, invoke(layerEnumDestroy, s.handle, handle)) }()
	for {
		var layers **nativeLayer
		var count uint32
		if err = invoke(layerEnum, s.handle, handle, 256, uintptr(unsafe.Pointer(&layers)), uintptr(unsafe.Pointer(&count))); err != nil {
			return nil, err
		}
		if layers == nil {
			if count != 0 {
				return nil, fmt.Errorf("FwpmLayerEnum0 returned nil entries")
			}
			return keys, nil
		}
		func() {
			defer free(unsafe.Pointer(layers))
			for _, layer := range unsafe.Slice(layers, int(count)) {
				if layer == nil {
					err = fmt.Errorf("FwpmLayerEnum0 returned nil layer")
					return
				}
				keys = append(keys, layer.Key)
			}
		}()
		if err != nil {
			return nil, err
		}
		if count == 0 {
			return keys, nil
		}
	}
}
