//go:build !windows

package helper

import (
	"errors"
	"slices"
	"strconv"
	"testing"
)

const testBreezeGID = 350

// The helper spawn must carry the breeze group across the uid/gid drop, or
// Assist cannot dial the 0660 root:breeze agent.sock nor read the 0640
// root:breeze helper_token.yaml (#8398).
func TestSpawnCredentialKeepsBreezeGroupForAMember(t *testing.T) {
	cred, warn, err := spawnCredentialFromIDs("501", "20", []string{"20", "12", "80", "350"}, nil, testBreezeGID, 16)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if warn != "" {
		t.Fatalf("unexpected warning: %q", warn)
	}
	if cred.Uid != 501 || cred.Gid != 20 {
		t.Fatalf("uid/gid = %d/%d, want 501/20", cred.Uid, cred.Gid)
	}
	if !slices.Contains(cred.Groups, uint32(testBreezeGID)) {
		t.Fatalf("Groups %v is missing the breeze gid %d", cred.Groups, testBreezeGID)
	}
	for _, g := range []uint32{20, 12, 80} {
		if !slices.Contains(cred.Groups, g) {
			t.Fatalf("Groups %v is missing supplementary gid %d", cred.Groups, g)
		}
	}
	if cred.NoSetGroups {
		t.Fatal("NoSetGroups must stay false: the child must not inherit root's groups")
	}
}

// Membership is the authorization signal. A user outside the breeze group must
// not gain it just because the agent spawned their helper.
func TestSpawnCredentialDoesNotGrantBreezeGroupToANonMember(t *testing.T) {
	cred, _, err := spawnCredentialFromIDs("502", "20", []string{"20", "12"}, nil, testBreezeGID, 16)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if slices.Contains(cred.Groups, uint32(testBreezeGID)) {
		t.Fatalf("Groups %v contains the breeze gid for a non-member", cred.Groups)
	}
	if !slices.Equal(cred.Groups, []uint32{20, 12}) {
		t.Fatalf("Groups = %v, want [20 12]", cred.Groups)
	}
}

// Groups must never be empty: an empty list makes Go call setgroups(0, …),
// which is the #8398 bug itself.
func TestSpawnCredentialAlwaysCarriesThePrimaryGroup(t *testing.T) {
	cred, _, err := spawnCredentialFromIDs("502", "20", nil, nil, -1, 16)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !slices.Equal(cred.Groups, []uint32{20}) {
		t.Fatalf("Groups = %v, want [20]", cred.Groups)
	}
}

func TestSpawnCredentialGroupLookupFailureFallsBackToPrimaryPlusBreeze(t *testing.T) {
	lookupErr := errors.New("getgrouplist failed")

	cred, warn, err := spawnCredentialFromIDs("501", "20", nil, lookupErr, testBreezeGID, 16)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !slices.Equal(cred.Groups, []uint32{20, testBreezeGID}) {
		t.Fatalf("Groups = %v, want [20 %d]", cred.Groups, testBreezeGID)
	}
	if warn == "" {
		t.Fatal("a failed group lookup must produce a warning")
	}

	cred, _, err = spawnCredentialFromIDs("501", "20", nil, lookupErr, -1, 16)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !slices.Equal(cred.Groups, []uint32{20}) {
		t.Fatalf("Groups with unresolvable breeze gid = %v, want [20]", cred.Groups)
	}
}

// macOS setgroups(2) rejects more than NGROUPS_MAX (16) entries with EINVAL,
// which would stop Assist from launching at all. Truncation must keep the
// primary and breeze gids, and say it happened.
func TestSpawnCredentialCapsGroupsWithoutDroppingBreeze(t *testing.T) {
	var ids []string
	for i := 1; i <= 19; i++ {
		ids = append(ids, strconv.Itoa(1000+i))
	}
	ids = append(ids[:18], "350", ids[18]) // breeze at index 18, past the cap
	ids = append([]string{"20"}, ids...)

	cred, warn, err := spawnCredentialFromIDs("501", "20", ids, nil, testBreezeGID, 16)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cred.Groups) != 16 {
		t.Fatalf("len(Groups) = %d, want 16: %v", len(cred.Groups), cred.Groups)
	}
	if cred.Groups[0] != 20 || cred.Groups[1] != testBreezeGID {
		t.Fatalf("Groups must start [20 %d], got %v", testBreezeGID, cred.Groups)
	}
	if warn == "" {
		t.Fatal("truncation must produce a warning")
	}
}

func TestSpawnCredentialSkipsRootDuplicateAndMalformedGroups(t *testing.T) {
	cred, _, err := spawnCredentialFromIDs("501", "20", []string{"20", "0", "abc", "12", "12", "-5"}, nil, -1, 16)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !slices.Equal(cred.Groups, []uint32{20, 12}) {
		t.Fatalf("Groups = %v, want [20 12]", cred.Groups)
	}
}

func TestSpawnCredentialRejectsMalformedIDs(t *testing.T) {
	if _, _, err := spawnCredentialFromIDs("x", "20", nil, nil, -1, 16); err == nil {
		t.Fatal("want error for non-numeric uid")
	}
	if _, _, err := spawnCredentialFromIDs("501", "x", nil, nil, -1, 16); err == nil {
		t.Fatal("want error for non-numeric gid")
	}
}
