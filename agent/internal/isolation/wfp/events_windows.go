//go:build windows

package wfp

import (
	"fmt"
	"golang.org/x/sys/windows"
	"log/slog"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"
)

// BFE's collection option is global, so overlapping probe subscriptions share
// one lease and only the final cancellation restores the original value.
var collection struct {
	sync.Mutex
	users    int
	previous uintptr
}
var subscriptions sync.Map
var subscriptionSequence atomic.Uintptr

type dropSubscription struct {
	mu     sync.Mutex
	ids    map[uint64]bool
	events chan DropEvent
	closed bool
}

var dropCallback = windows.NewCallback(func(context uintptr, event *nativeEvent1) uintptr {
	// FwpmNetEventSubscribe0's CALLBACK0 receives EVENT1, not EVENT0.
	if event == nil || event.Type != 3 || event.Data == nil {
		return 0
	}
	v, ok := subscriptions.Load(context)
	if !ok {
		return 0
	}
	s := v.(*dropSubscription)
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed && s.ids[event.Data.FilterID] {
		select {
		case s.events <- DropEvent{FilterID: event.Data.FilterID}:
		default:
		}
	}
	return 0
})

// SubscribeClassifyDrops observes only the specified installed block filters.
// Cancellation unsubscribes, restores net-event collection and closes the channel.
// Failures are returned so the negative probe cannot mistake silence for proof.
func SubscribeClassifyDrops(filterIDs []uint64) (<-chan DropEvent, func(), error) {
	if len(filterIDs) == 0 {
		return nil, nil, fmt.Errorf("no block filter IDs for WFP drop subscription")
	}
	s, err := OpenSession()
	if err != nil {
		return nil, nil, err
	}
	collection.Lock()
	defer collection.Unlock()
	if collection.users == 0 {
		var old *nativeValue
		if err = invoke(engineGetOption, s.handle, 0, uintptr(unsafe.Pointer(&old))); err != nil {
			s.Close()
			return nil, nil, err
		}
		if old == nil {
			s.Close()
			return nil, nil, fmt.Errorf("FwpmEngineGetOption0 returned nil value")
		}
		if old.Type != 3 {
			free(unsafe.Pointer(old))
			s.Close()
			return nil, nil, fmt.Errorf("FwpmEngineGetOption0 returned unexpected option type")
		}
		collection.previous = uintptr(old.uint32())
		free(unsafe.Pointer(old))
		if collection.previous == 0 {
			if err = setCollection(s, 1); err != nil {
				s.Close()
				return nil, nil, err
			}
		}
	}
	state := &dropSubscription{ids: make(map[uint64]bool, len(filterIDs)), events: make(chan DropEvent, 64)}
	for _, id := range filterIDs {
		state.ids[id] = true
	}
	context := subscriptionSequence.Add(1)
	subscriptions.Store(context, state)
	n := &nativeSubscription{}
	var pin runtime.Pinner
	pin.Pin(n)
	defer pin.Unpin()
	var handle uintptr
	err = invoke(netSubscribe, s.handle, uintptr(unsafe.Pointer(n)), dropCallback, context, uintptr(unsafe.Pointer(&handle)))
	if err != nil {
		subscriptions.Delete(context)
		if collection.users == 0 {
			if e := setCollection(s, collection.previous); e != nil {
				slog.Error("restore WFP net-event collection after subscription failure", "error", e)
			}
		}
		s.Close()
		return nil, nil, err
	}
	collection.users++
	var once sync.Once
	cancel := func() {
		once.Do(func() {
			state.mu.Lock()
			state.closed = true
			close(state.events)
			state.mu.Unlock()
			subscriptions.Delete(context)
			if e := invoke(netUnsubscribe, s.handle, handle); e != nil {
				slog.Error("unsubscribe WFP classify-drop events", "error", e)
			}
			collection.Lock()
			defer collection.Unlock()
			collection.users--
			if collection.users == 0 {
				if e := setCollection(s, collection.previous); e != nil {
					slog.Error("restore WFP net-event collection", "error", e)
				}
			}
			if e := s.Close(); e != nil {
				slog.Error("close WFP drop subscription engine", "error", e)
			}
		})
	}
	return state.events, cancel, nil
}
func setCollection(s *Session, value uintptr) error {
	n := &nativeValue{Type: 3, Value: value}
	var pin runtime.Pinner
	pin.Pin(n)
	defer pin.Unpin()
	return invoke(engineSetOption, s.handle, 0, uintptr(unsafe.Pointer(n)))
}
