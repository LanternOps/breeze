package securefs

import "strings"

// privateDACLPolicy is what a private directory's DACL must satisfy.
type privateDACLPolicy struct {
	// allowed are the only trustees an entry may name.
	allowed map[string]bool
	// fullAccess are trustees that need a full-control entry that applies
	// to the directory itself.
	fullAccess map[string]bool
	// requireProtected is set for directories the agent creates or sets
	// itself: their DACL must not inherit from the parent and so carries no
	// inherited entries. An existing root may instead inherit its entries,
	// as long as every entry, inherited or explicit, meets the rules above.
	requireProtected bool
}

// privateDACLConforms reports whether sddl, the string form of a directory's
// DACL ("D:<flags>(<ace>)..."), meets policy. Every entry must be an allow
// entry for an allowed trustee that is inherited by subfolders and files. A
// null or empty DACL, deny entries and entries for any other trustee never
// conform.
func privateDACLConforms(sddl string, policy privateDACLPolicy) bool {
	if !strings.HasPrefix(sddl, "D:") {
		return false
	}
	body := sddl[len("D:"):]
	start := strings.Index(body, "(")
	if start < 0 {
		return false
	}
	protected := strings.Contains(body[:start], "P")
	if policy.requireProtected && !protected {
		return false
	}
	entries := directoryACEFields(body)
	if len(entries) == 0 {
		return false
	}
	full := map[string]bool{}
	for _, fields := range entries {
		kind, rights, trustee := fields[0], fields[2], fields[5]
		if kind != "A" || !policy.allowed[trustee] {
			return false
		}
		flags, ok := aceFlagTokens(fields[1])
		if !ok || !flags["OI"] || !flags["CI"] {
			return false
		}
		if policy.requireProtected && flags["ID"] {
			return false
		}
		if !flags["IO"] && (rights == "FA" || strings.EqualFold(rights, "0x1f01ff")) {
			full[trustee] = true
		}
	}
	for trustee := range policy.fullAccess {
		if !full[trustee] {
			return false
		}
	}
	return true
}

// aceFlagTokens splits an entry's flags field ("OICIID") into its two-letter
// flags, so a flag is matched only as a whole token and never across two
// neighbouring ones. ok is false when the field has an odd length.
func aceFlagTokens(field string) (flags map[string]bool, ok bool) {
	if len(field)%2 != 0 {
		return nil, false
	}
	flags = make(map[string]bool, len(field)/2)
	for i := 0; i < len(field); i += 2 {
		flags[field[i:i+2]] = true
	}
	return flags, true
}

// directoryACEFields splits the access entries of an SDDL string into their
// six fields. It returns nil when any entry is malformed.
func directoryACEFields(sddl string) [][]string {
	start := strings.Index(sddl, "(")
	if start < 0 || !strings.HasSuffix(sddl, ")") {
		return nil
	}
	rules := strings.Split(sddl[start+1:len(sddl)-1], ")(")
	fieldsList := make([][]string, 0, len(rules))
	for _, rule := range rules {
		fields := strings.Split(rule, ";")
		if len(fields) != 6 {
			return nil
		}
		fieldsList = append(fieldsList, fields)
	}
	return fieldsList
}
