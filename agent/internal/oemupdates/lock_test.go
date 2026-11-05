package oemupdates

import (
	"errors"
	"testing"
)

func TestSecondRunRefusedWhileLocked(t *testing.T) {
	store := newMemStore()
	release, err := AcquireRunLock(store)
	if err != nil {
		t.Fatalf("first lock: %v", err)
	}
	defer release()
	if _, err := AcquireRunLock(store); !errors.Is(err, ErrRunInFlight) {
		t.Fatalf("second lock = %v, want ErrRunInFlight", err)
	}
}

func TestLockClearedAfterRelease(t *testing.T) {
	store := newMemStore()
	release, err := AcquireRunLock(store)
	if err != nil {
		t.Fatalf("first lock: %v", err)
	}
	release()
	release() // safe twice
	again, err := AcquireRunLock(store)
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	again()
}

func TestLocksOnDifferentStoresAreIndependent(t *testing.T) {
	a, b := newMemStore(), newMemStore()
	ra, err := AcquireRunLock(a)
	if err != nil {
		t.Fatal(err)
	}
	defer ra()
	rb, err := AcquireRunLock(b)
	if err != nil {
		t.Fatalf("a lock on another store must not block: %v", err)
	}
	rb()
}
