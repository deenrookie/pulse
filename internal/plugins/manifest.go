// R3 plugin projects: a subdirectory with pulse.plugin.json is loaded as one
// plugin from its declared entry artifact. The manifest is the identity
// authority (id wins over the code's own `plugin` metadata for identity
// keys); duplicate ids are reported instead of silently shadowing.
package plugins

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Manifest is pulse.plugin.json.
type Manifest struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version"`
	Entry   string `json:"entry"` // relative to the project dir, e.g. dist/plugin.js
	Description string `json:"description,omitempty"`
}

// loadDirProject reads <dir>/pulse.plugin.json and returns the entry source
// plus the manifest. Errors describe the project, not the caller.
func loadDirProject(dir string) (src string, m Manifest, err error) {
	raw, err := os.ReadFile(filepath.Join(dir, "pulse.plugin.json"))
	if err != nil {
		return "", m, fmt.Errorf("read manifest: %w", err)
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", m, fmt.Errorf("parse manifest: %w", err)
	}
	if m.Entry == "" {
		m.Entry = "dist/plugin.js"
	}
	entry := filepath.Clean(m.Entry)
	if filepath.IsAbs(entry) {
		return "", m, fmt.Errorf("manifest entry must be relative, got %q", m.Entry)
	}
	b, err := os.ReadFile(filepath.Join(dir, entry))
	if err != nil {
		return "", m, fmt.Errorf("read entry %s: %w", entry, err)
	}
	return string(b), m, nil
}

// applyManifestIdentity overrides display/identity fields from the manifest
// after the code's own metadata was extracted. The manifest wins for
// name/version; the id becomes p.Identity.
func (p *Plugin) applyManifestIdentity(m Manifest) {
	if m.Name != "" {
		p.Name = m.Name
	}
	if m.Version != "" {
		p.Version = m.Version
	}
	p.Identity = m.ID
	p.Dir = true
}
