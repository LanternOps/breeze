package psscript

import "strings"

// singleQuoteEscaper doubles each character PowerShell's tokenizer accepts as a
// single-quote delimiter: the ASCII apostrophe and the typographic single
// quotes U+2018, U+2019, U+201A and U+201B. Any of them can end a literal
// opened with an ASCII apostrophe, so each must be escaped, not only the
// ASCII one.
var singleQuoteEscaper = strings.NewReplacer(
	"'", "''",
	"\u2018", "\u2018\u2018",
	"\u2019", "\u2019\u2019",
	"\u201a", "\u201a\u201a",
	"\u201b", "\u201b\u201b",
)

// EscapeSingleQuoted returns s escaped for use between the quotes of a
// PowerShell single-quoted string literal ('...'). Every single-quote
// delimiter is doubled, which PowerShell reads back as one literal character.
// Nothing else needs escaping: a single-quoted literal expands no variables,
// subexpressions or escape sequences, and may span lines.
//
// Use it for every value written into a generated PowerShell script, or use
// Quote, which also adds the surrounding quotes.
func EscapeSingleQuoted(s string) string {
	return singleQuoteEscaper.Replace(s)
}

// Quote returns s as a complete PowerShell single-quoted string literal.
func Quote(s string) string {
	return "'" + EscapeSingleQuoted(s) + "'"
}
