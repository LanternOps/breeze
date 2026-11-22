package oemupdates

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const maxVersionParts = 4

// parseVersion reads a dotted numeric version of 1 to 4 parts. Anything else,
// including pre-release suffixes, is refused: an unreadable version is never in
// range.
func parseVersion(v string) ([]uint64, error) {
	if v == "" {
		return nil, errors.New("empty version")
	}
	parts := strings.Split(v, ".")
	if len(parts) > maxVersionParts {
		return nil, fmt.Errorf("version %q has more than %d parts", v, maxVersionParts)
	}
	out := make([]uint64, len(parts))
	for i, p := range parts {
		if p == "" || strings.TrimLeft(p, "0123456789") != "" {
			return nil, fmt.Errorf("version %q is not dotted numbers", v)
		}
		n, err := strconv.ParseUint(p, 10, 32)
		if err != nil {
			return nil, fmt.Errorf("version %q: %w", v, err)
		}
		out[i] = n
	}
	return out, nil
}

// compareVersions returns -1, 0 or 1. Missing parts count as zero.
func compareVersions(a, b string) (int, error) {
	va, err := parseVersion(a)
	if err != nil {
		return 0, err
	}
	vb, err := parseVersion(b)
	if err != nil {
		return 0, err
	}
	for i := 0; i < maxVersionParts; i++ {
		var x, y uint64
		if i < len(va) {
			x = va[i]
		}
		if i < len(vb) {
			y = vb[i]
		}
		switch {
		case x < y:
			return -1, nil
		case x > y:
			return 1, nil
		}
	}
	return 0, nil
}

func versionMajor(v string) (uint64, error) {
	p, err := parseVersion(v)
	if err != nil {
		return 0, err
	}
	return p[0], nil
}

// versionAtLeast is false for anything unreadable.
func versionAtLeast(v, min string) bool {
	c, err := compareVersions(v, min)
	return err == nil && c >= 0
}

type rangePosition int

const (
	inRange rangePosition = iota
	belowRange
	aboveRange
	unreadable
)

func (r VersionRange) position(v string) rangePosition {
	lo, err := compareVersions(v, r.Min)
	if err != nil {
		return unreadable
	}
	if lo < 0 {
		return belowRange
	}
	hi, err := compareVersions(v, r.MaxExclusive)
	if err != nil {
		return unreadable
	}
	if hi >= 0 {
		return aboveRange
	}
	return inRange
}

// effectiveRange intersects the lane's compiled range with the payload's. The
// payload can only narrow it: the floor is the highest of the three minimums,
// the ceiling the lower of the two.
func effectiveRange(compiled VersionRange, spec *ToolSpec) (VersionRange, error) {
	eff := compiled
	if _, err := compareVersions(eff.Min, eff.MaxExclusive); err != nil {
		return VersionRange{}, fmt.Errorf("compiled range: %w", err)
	}
	if spec == nil {
		return eff, nil
	}
	for _, min := range []string{spec.MinSafeVersion, spec.SupportedRange.Min} {
		c, err := compareVersions(min, eff.Min)
		if err != nil {
			return VersionRange{}, err
		}
		if c > 0 {
			eff.Min = min
		}
	}
	c, err := compareVersions(spec.SupportedRange.MaxExclusive, eff.MaxExclusive)
	if err != nil {
		return VersionRange{}, err
	}
	if c < 0 {
		eff.MaxExclusive = spec.SupportedRange.MaxExclusive
	}
	if c, _ := compareVersions(eff.Min, eff.MaxExclusive); c >= 0 {
		return VersionRange{}, errors.New("supported range is empty")
	}
	return eff, nil
}
