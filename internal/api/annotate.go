// Flow annotations (star + note) live beside the store in flow-notes.json —
// the JSONL flow log stays append-only and untouched.
package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"pulse/internal/store"
)

type flowAnno struct {
	Star bool   `json:"star"`
	Note string `json:"note"`
}

type annoStore struct {
	mu   sync.Mutex
	m    map[string]flowAnno
	path string
}

func newAnnoStore(dataDir string) *annoStore {
	a := &annoStore{path: filepath.Join(dataDir, "flow-notes.json"), m: map[string]flowAnno{}}
	if data, err := os.ReadFile(a.path); err == nil {
		json.Unmarshal(data, &a.m)
	}
	return a
}

func (a *annoStore) save() {
	if data, err := json.MarshalIndent(a.m, "", "  "); err == nil {
		_ = os.WriteFile(a.path, data, 0o644)
	}
}

func (a *annoStore) get(id string) flowAnno { return a.m[id] }

func (a *annoStore) set(id string, patch flowAnno, hasStar, hasNote bool) flowAnno {
	a.mu.Lock()
	defer a.mu.Unlock()
	cur := a.m[id]
	if hasStar {
		cur.Star = patch.Star
	}
	if hasNote {
		cur.Note = patch.Note
	}
	if cur.Star || cur.Note != "" {
		a.m[id] = cur
	} else {
		delete(a.m, id)
	}
	a.save()
	return cur
}

// annotatedMeta flattens store.FlowMeta with the annotation fields so the
// traffic table gets star/note in the same response shape as before.
type annotatedMeta struct {
	store.FlowMeta
	Star bool   `json:"star"`
	Note string `json:"note"`
}

// handleAnnotate: PUT /api/flows/{id}/annotate {"star"?,"note"?}
func (s *Server) handleAnnotate(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Star *bool   `json:"star"`
		Note *string `json:"note"`
	}
	if !readJSON(w, r, &body, 1<<16) {
		return
	}
	if _, ok := s.st.Get(id); !ok {
		writeErr(w, http.StatusNotFound, "no such flow: "+id)
		return
	}
	patch := flowAnno{}
	if body.Star != nil {
		patch.Star = *body.Star
	}
	if body.Note != nil {
		patch.Note = strings.TrimSpace(*body.Note)
	}
	anno := s.anno.set(id, patch, body.Star != nil, body.Note != nil)
	writeJSON(w, http.StatusOK, anno)
}
