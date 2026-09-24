// ctx.highlight(color): plugins mark the current flow in Live Traffic with a
// named color. Colors are a fixed whitelist so no arbitrary CSS reaches the UI.
package plugins

import "strings"

var highlightColors = map[string]struct{}{
	"red": {}, "orange": {}, "yellow": {}, "green": {}, "cyan": {},
	"blue": {}, "pink": {}, "magenta": {}, "purple": {}, "gray": {},
}

// CanonicalHighlightColor normalizes and validates a ctx.highlight color.
// The second return reports whether the name is one of the supported colors;
// the empty string means "clear the highlight" and is always valid.
func CanonicalHighlightColor(s string) (string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return "", true
	}
	if _, ok := highlightColors[s]; !ok {
		return "", false
	}
	return s, true
}
