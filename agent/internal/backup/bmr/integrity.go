package bmr

import (
	"fmt"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
)

// BootstrapIntegrity reads the integrity expectation a recovery bootstrap
// carries. The server may put the `integrity` block on the bootstrap itself
// or on its snapshot; both are accepted, and when both are present they
// must agree. (nil, nil) means the server sent none (a server that predates
// snapshot attestations). A block this helper cannot fully understand is an
// error wrapping integrity.ErrInvalidExpectation, and the recovery must fail
// before anything is written — never fall back to the unchecked path.
//
// The expectation is also checked against the bootstrap's snapshot id, so a
// block issued for another snapshot is refused here.
func BootstrapIntegrity(bs *BootstrapResponse) (*integrity.Expectation, error) {
	if bs == nil {
		return nil, nil
	}
	var fromSnapshot, fromTop *integrity.Expectation
	var err error
	if bs.Snapshot != nil {
		if fromSnapshot, err = integrity.Parse(bs.Snapshot.Integrity); err != nil {
			return nil, fmt.Errorf("bootstrap snapshot integrity: %w", err)
		}
	}
	if fromTop, err = integrity.Parse(bs.Integrity); err != nil {
		return nil, fmt.Errorf("bootstrap integrity: %w", err)
	}
	e := fromSnapshot
	switch {
	case fromSnapshot == nil:
		e = fromTop
	case fromTop != nil && !sameExpectation(fromSnapshot, fromTop):
		return nil, fmt.Errorf("%w: the bootstrap carries two different integrity blocks", integrity.ErrInvalidExpectation)
	}
	if e != nil && bs.Snapshot != nil && bs.Snapshot.SnapshotID != "" {
		if err := e.CheckSnapshot(bs.Snapshot.SnapshotID); err != nil {
			return nil, err
		}
	}
	return e, nil
}

// ResolveIntegrity combines the expectation a device command's payload
// carried (bmr_recover, bare_metal_rebuild) with the one the recovery
// bootstrap carried. Either may be absent. When both are present the
// stricter wins: an attested expectation over an override or informational
// one (the command's is kept between two non-attested blocks, since it is
// the one bound to an authorization). Two attested expectations must
// describe the same attestation, otherwise the recovery is refused.
func ResolveIntegrity(fromCommand, fromBootstrap *integrity.Expectation) (*integrity.Expectation, error) {
	switch {
	case fromCommand == nil:
		return fromBootstrap, nil
	case fromBootstrap == nil:
		return fromCommand, nil
	case fromCommand.Attested() && fromBootstrap.Attested():
		if fromCommand.SnapshotID != fromBootstrap.SnapshotID || !sameObjects(fromCommand.Objects, fromBootstrap.Objects) {
			return nil, fmt.Errorf("%w: the command and the recovery bootstrap carry different snapshot attestations", integrity.ErrInvalidExpectation)
		}
		return fromCommand, nil
	case fromBootstrap.Attested():
		return fromBootstrap, nil
	default:
		return fromCommand, nil
	}
}

// sameExpectation reports whether two parsed integrity blocks say the same
// thing: the same version, mode, trust, snapshot, authorization and reason,
// and the same set of objects in any order.
func sameExpectation(a, b *integrity.Expectation) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.V == b.V &&
		a.Mode == b.Mode &&
		a.Trust == b.Trust &&
		a.SnapshotID == b.SnapshotID &&
		a.AuthorizationID == b.AuthorizationID &&
		a.Reason == b.Reason &&
		sameObjects(a.Objects, b.Objects)
}

// sameObjects compares two attested object lists as multisets: the same
// objects, each as many times, regardless of order.
func sameObjects(a, b []integrity.Object) bool {
	if len(a) != len(b) {
		return false
	}
	counts := make(map[integrity.Object]int, len(a))
	for _, o := range a {
		counts[o]++
	}
	for _, o := range b {
		if counts[o] == 0 {
			return false
		}
		counts[o]--
	}
	return true
}
