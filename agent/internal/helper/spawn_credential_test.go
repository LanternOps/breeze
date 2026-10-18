//go:build !windows

package helper

import (
	"errors"
	"math"
	"os/user"
	"slices"
	"strconv"
	"strings"
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

// Production passes breezeGID = -1 on the common path (the group list is short
// and was read fine), so breeze must still come through from groupIDs alone.
func TestSpawnCredentialKeepsBreezeWhenBreezeGIDNotResolved(t *testing.T) {
	cred, warn, err := spawnCredentialFromIDs("501", "20", []string{"20", "12", "350"}, nil, -1, 16)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if warn != "" {
		t.Fatalf("unexpected warning: %q", warn)
	}
	if !slices.Equal(cred.Groups, []uint32{20, 12, 350}) {
		t.Fatalf("Groups = %v, want [20 12 350]", cred.Groups)
	}
}

// When breeze could not be resolved, truncation cannot protect it, and the
// warning must not claim it did.
func TestSpawnCredentialTruncationWarningIsHonestWhenBreezeUnresolved(t *testing.T) {
	ids := []string{"20"}
	for i := 1; i <= 19; i++ {
		ids = append(ids, strconv.Itoa(1000+i))
	}
	cred, warn, err := spawnCredentialFromIDs("501", "20", ids, nil, -1, 16)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cred.Groups) != 16 || cred.Groups[0] != 20 {
		t.Fatalf("Groups = %v, want 16 entries starting with 20", cred.Groups)
	}
	if warn == "" || strings.Contains(warn, "keeps its primary and breeze") {
		t.Fatalf("warning must say breeze may have been dropped, got %q", warn)
	}
}

// The wrapper must feed the real group database into the decision: for the
// test-running user it yields their primary gid first, never an empty list,
// and (when under the cap) every group the user has.
func TestSpawnCredentialWrapperUsesTheUserGroupList(t *testing.T) {
	u, err := user.Current()
	if err != nil {
		t.Skipf("no current user: %v", err)
	}
	ids, err := u.GroupIds()
	if err != nil {
		t.Skipf("host cannot list groups: %v", err)
	}
	cred, err := spawnCredential(u)
	if err != nil {
		t.Fatalf("spawnCredential: %v", err)
	}
	gid, _ := strconv.ParseUint(u.Gid, 10, 32)
	if len(cred.Groups) == 0 || cred.Groups[0] != uint32(gid) {
		t.Fatalf("Groups = %v, want primary gid %d first", cred.Groups, gid)
	}
	if len(ids) > spawnMaxGroups() {
		return
	}
	for _, s := range ids {
		n, err := strconv.ParseUint(s, 10, 32)
		if err != nil || n == 0 {
			continue
		}
		if !slices.Contains(cred.Groups, uint32(n)) {
			t.Fatalf("Groups %v is missing the user's group %d", cred.Groups, n)
		}
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

// The breeze gid arrives as a platform int (Atoi on the group database). A gid
// can never exceed uint32; a value outside that range is treated as unresolved
// rather than silently truncated into some other group.
func TestSpawnCredentialIgnoresOutOfRangeBreezeGID(t *testing.T) {
	if strconv.IntSize < 64 {
		t.Skip("int cannot exceed uint32 on this platform")
	}
	tooBig := math.MaxInt // > math.MaxUint32 on 64-bit
	cred, _, err := spawnCredentialFromIDs("501", "20", nil, errors.New("getgrouplist failed"), tooBig, 16)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !slices.Equal(cred.Groups, []uint32{20}) {
		t.Fatalf("Groups with out-of-range breeze gid = %v, want [20]", cred.Groups)
	}
}
