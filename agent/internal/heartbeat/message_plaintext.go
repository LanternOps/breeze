package heartbeat

import (
	"regexp"
	"strings"
	"sync"
)

// The native toast cannot render markdown, so the body the Assist card would
// format is flattened to readable text. Links keep their REAL target visible
// next to the label (a toast is not clickable, and the label is never
// trusted); images collapse to their alt text so nothing implies a load.
var (
	mdImage     = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`!\[([^\]]*)\]\([^)]*\)`) })
	mdLink      = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`\[([^\]]*)\]\(([^)\s]*)[^)]*\)`) })
	mdBoldStar  = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`\*\*([^*\n]+)\*\*`) })
	mdBoldUnder = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`__([^_\n]+)__`) })
	mdItalStar  = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`\*([^*\n]+)\*`) })
	mdItalUnder = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`(^|[^\w])_([^_\n]+)_([^\w]|$)`) })
	mdStrike    = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`~~([^~\n]+)~~`) })
	mdCode      = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile("`([^`\n]*)`") })
	mdHeading   = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`(?m)^[ \t]{0,3}#{1,6}[ \t]+`) })
	mdQuote     = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`(?m)^[ \t]{0,3}>[ \t]?`) })
	mdBullet    = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`(?m)^([ \t]*)[-*+][ \t]+`) })
)

func plainTextFromMarkdown(s string) string {
	s = mdImage().ReplaceAllString(s, "$1")
	s = mdLink().ReplaceAllString(s, "$1 ($2)")
	s = mdHeading().ReplaceAllString(s, "")
	s = mdQuote().ReplaceAllString(s, "")
	s = mdBullet().ReplaceAllString(s, "$1• ")
	s = mdCode().ReplaceAllString(s, "$1")
	s = mdStrike().ReplaceAllString(s, "$1")
	s = mdBoldStar().ReplaceAllString(s, "$1")
	s = mdBoldUnder().ReplaceAllString(s, "$1")
	s = mdItalStar().ReplaceAllString(s, "$1")
	s = mdItalUnder().ReplaceAllString(s, "$1$2$3")
	return strings.TrimSpace(s)
}
