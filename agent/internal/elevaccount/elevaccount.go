package elevaccount

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
)

const (
	// AccountName is the dormant local admin account managed by the agent.
	AccountName = "~breeze_elev"

	defaultPasswordLength = 40
	minPasswordLength     = 32
)

var (
	upperChars  = []rune("ABCDEFGHJKLMNPQRSTUVWXYZ")
	lowerChars  = []rune("abcdefghijkmnopqrstuvwxyz")
	digitChars  = []rune("23456789")
	symbolChars = []rune("!@#$%^&*_-+=?")
	allChars    = []rune("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-+=?")

	// ErrUnsupportedPlatform is returned by the !windows stub.
	ErrUnsupportedPlatform = errors.New("unsupported_platform")
)

// Credential is the cleartext credential minted locally for one actuation
// window. Callers must clear Password after invoking the actuator.
type Credential struct {
	Username string
	Password string
}

// AccountManager owns the lifecycle for the dormant local elevation account.
type AccountManager interface {
	EnsureProvisioned() error
	Promote(ctx context.Context) (Credential, error)
	Demote(ctx context.Context) error
}

// New returns the platform-default AccountManager. On non-Windows this is a
// no-op manager whose Promote returns ErrUnsupportedPlatform.
func New() AccountManager {
	return newManager()
}

// GeneratePassword is exported for tests. It uses crypto/rand, enforces a
// minimum length of 32, and guarantees upper/lower/digit/symbol complexity.
func GeneratePassword(length int) (string, error) {
	if length < minPasswordLength {
		length = minPasswordLength
	}

	runes := make([]rune, length)
	required := [][]rune{upperChars, lowerChars, digitChars, symbolChars}
	for i, set := range required {
		r, err := randomRune(set)
		if err != nil {
			return "", err
		}
		runes[i] = r
	}
	for i := len(required); i < len(runes); i++ {
		r, err := randomRune(allChars)
		if err != nil {
			return "", err
		}
		runes[i] = r
	}

	for i := len(runes) - 1; i > 0; i-- {
		j, err := randomInt(i + 1)
		if err != nil {
			return "", err
		}
		runes[i], runes[j] = runes[j], runes[i]
	}

	return string(runes), nil
}

func randomRune(set []rune) (rune, error) {
	n, err := randomInt(len(set))
	if err != nil {
		return 0, err
	}
	return set[n], nil
}

func randomInt(max int) (int, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(max)))
	if err != nil {
		return 0, err
	}
	return int(n.Int64()), nil
}

type lifecycleState string

const (
	stateProvisioned lifecycleState = "provisioned"
	statePromoted    lifecycleState = "promoted"
	stateDemoted     lifecycleState = "demoted"
)

func nextLifecycleState(current lifecycleState, event string) lifecycleState {
	switch event {
	case "ensure":
		return stateProvisioned
	case "promote":
		return statePromoted
	case "demote":
		return stateDemoted
	default:
		return current
	}
}

func shouldStartupDemote(accountExists, inAdministrators bool) bool {
	return accountExists && inAdministrators
}
