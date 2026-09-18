package plugins

import (
	"archive/zip"
	"bytes"
	"embed"
	"io/fs"
)

//go:embed skills/pulse-plugin-dev
var skillFS embed.FS

func PluginSkill() string {
	b, _ := skillFS.ReadFile("skills/pulse-plugin-dev/SKILL.md")
	return string(b)
}

// The source, UI and downloadable kit all use the same embedded files.
func PluginSkillArchive() ([]byte, error) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	err := fs.WalkDir(skillFS, "skills", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := skillFS.ReadFile(path)
		if err != nil {
			return err
		}
		file, err := w.Create(path[len("skills/"):])
		if err != nil {
			return err
		}
		_, err = file.Write(data)
		return err
	})
	if err != nil {
		return nil, err
	}
	file, err := w.Create("pulse-plugin-dev/assets/pulse.d.ts")
	if err != nil {
		return nil, err
	}
	if _, err := file.Write([]byte(SDKDTS())); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
