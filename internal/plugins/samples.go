// Embedded plugin samples served to the UI's Samples tab. They live in the
// binary so a fresh clone shows them without touching disk, and the test
// suite exercises the very same sources the console displays.
package plugins

import (
	"embed"
)

//go:embed samples/*.js
var sampleFS embed.FS

// Sample is one showcase entry for the Samples tab.
type Sample struct {
	File string `json:"file"`
	Desc string `json:"desc"`
	Src  string `json:"src"`
}

// sampleOrder pins the display order (flagship demo first) and doubles as
// the single place a new sample file gets registered.
var sampleOrder = []struct{ file, desc string }{
	{"demo-read-rewrite.js", "Read & rewrite everything: path, query params, headers, POST body, response headers/body"},
	{"add-header.js", "Request hook · add a header, use pulse.log"},
	{"redact-tokens.js", "Response hook · regex redaction of secrets"},
	{"template.js", "Minimal skeleton for a new plugin"},
}

// Samples returns the showcase entries; sources come from the embed FS.
func Samples() []Sample {
	out := make([]Sample, 0, len(sampleOrder))
	for _, s := range sampleOrder {
		src, err := sampleFS.ReadFile("samples/" + s.file)
		if err != nil {
			continue
		}
		out = append(out, Sample{File: s.file, Desc: s.desc, Src: string(src)})
	}
	return out
}

// SampleSource returns the raw source of one embedded sample (tests).
func SampleSource(file string) (string, bool) {
	src, err := sampleFS.ReadFile("samples/" + file)
	if err != nil {
		return "", false
	}
	return string(src), true
}
