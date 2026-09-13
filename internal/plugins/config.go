// R1 configuration: plugins declare a config schema in their `plugin`
// metadata; the host renders it as a form, stores user values per plugin
// file (secrets never echoed back), and injects a snapshot into ctx.config
// on every hook call.
package plugins

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/dop251/goja"
)

var errStoreTooLarge = errors.New("store exceeds the 256 KB budget")

// ConfigField is one declared config entry.
type ConfigField struct {
	Type     string `json:"type"`              // string | number | boolean | select | secret
	Label    string `json:"label,omitempty"`   // form label
	Default  any    `json:"default,omitempty"` // default value
	Required bool   `json:"required,omitempty"`
	Options  []string `json:"options,omitempty"` // select choices
	Hint     string `json:"hint,omitempty"`
}

// extractConfig pulls plugin.config from the compiled VM (only schema —
// values live server-side, never in source).
func extractConfig(vm *goja.Runtime) map[string]ConfigField {
	v := vm.Get(metadataVar)
	if v == nil || v == goja.Undefined() || v == goja.Null() {
		return nil
	}
	obj, ok := v.(*goja.Object)
	if !ok {
		return nil
	}
	cv := obj.Get("config")
	if cv == nil || cv == goja.Undefined() || cv == goja.Null() {
		return nil
	}
	b, err := json.Marshal(cv.Export())
	if err != nil {
		return nil
	}
	var fields map[string]ConfigField
	if json.Unmarshal(b, &fields) != nil {
		return nil
	}
	for name, f := range fields {
		switch f.Type {
		case "string", "number", "boolean", "select", "secret":
		default:
			f.Type = "string"
			fields[name] = f
		}
	}
	return fields
}

// configManager persists per-plugin user values next to the plugin state.
type configManager struct {
	mu   sync.Mutex
	path string
	data map[string]map[string]any // plugin file -> key -> value
}

func openConfigs(path string) *configManager {
	c := &configManager{path: path, data: map[string]map[string]any{}}
	if b, err := os.ReadFile(path); err == nil {
		var m map[string]map[string]any
		if json.Unmarshal(b, &m) == nil && m != nil {
			c.data = m
		}
	}
	return c
}

func (c *configManager) persist() error {
	b, err := json.MarshalIndent(c.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

// snapshot returns the user values for a plugin merged with schema defaults
// (defaults only where the user has not set a value). Secrets are included —
// this feeds ctx.config inside the VM.
func (c *configManager) snapshot(file string, schema map[string]ConfigField) map[string]any {
	c.mu.Lock()
	user := c.data[file]
	c.mu.Unlock()
	out := map[string]any{}
	for k, f := range schema {
		if v, ok := user[k]; ok && v != nil {
			out[k] = v
		} else if f.Default != nil {
			out[k] = f.Default
		}
	}
	for k, v := range user { // extra keys not declared in the schema stay
		if _, declared := schema[k]; !declared {
			out[k] = v
		}
	}
	return out
}

// describe renders the schema + configured state for the UI; secrets report
// whether they are set, never the value.
func (c *configManager) describe(file string, schema map[string]ConfigField) []ConfigFieldView {
	c.mu.Lock()
	user := c.data[file]
	c.mu.Unlock()
	out := make([]ConfigFieldView, 0, len(schema))
	for name, f := range schema {
		v := ConfigFieldView{ConfigField: f, Name: name}
		if f.Type == "secret" {
			v.Set = user[name] != nil && user[name] != ""
		} else if dv, ok := user[name]; ok && dv != nil {
			v.Value = dv
		} else {
			v.Value = f.Default
		}
		out = append(out, v)
	}
	return out
}

// setValues validates and stores user values for a plugin; returns an error
// message naming the first invalid key.
func (c *configManager) setValues(file string, schema map[string]ConfigField, values map[string]any) error {
	for k, v := range values {
		f, declared := schema[k]
		if !declared {
			return errors.New("unknown config key: " + k)
		}
		switch f.Type {
		case "number":
			if _, ok := v.(float64); !ok {
				return errors.New("config " + k + ": want a number")
			}
		case "boolean":
			if _, ok := v.(bool); !ok {
				return errors.New("config " + k + ": want a boolean")
			}
		case "select":
			s, ok := v.(string)
			if !ok {
				return errors.New("config " + k + ": want a string")
			}
			valid := false
			for _, o := range f.Options {
				if o == s {
					valid = true
					break
				}
			}
			if !valid {
				return errors.New("config " + k + ": must be one of " + strings.Join(f.Options, ", "))
			}
		default:
			if _, ok := v.(string); !ok {
				return errors.New("config " + k + ": want a string")
			}
		}
	}
	c.mu.Lock()
	if c.data[file] == nil {
		c.data[file] = map[string]any{}
	}
	for k, v := range values {
		c.data[file][k] = v
	}
	c.mu.Unlock()
	return c.persist()
}

func (c *configManager) delete(file string) {
	c.mu.Lock()
	delete(c.data, file)
	c.mu.Unlock()
	_ = c.persist()
}

// ConfigFieldView is the UI-facing description of one config field.
type ConfigFieldView struct {
	ConfigField
	Name  string `json:"name"`
	Value any    `json:"value,omitempty"`
	Set   bool   `json:"set,omitempty"` // secrets: configured?
}

// configDir returns the directory for config/section files derived from the
// runtime state path (all under the data dir).
func configPathFor(statePath string) string { return filepath.Join(filepath.Dir(statePath), "plugin-config.json") }
func storesDirFor(statePath string) string  { return filepath.Join(filepath.Dir(statePath), "plugin-stores") }
