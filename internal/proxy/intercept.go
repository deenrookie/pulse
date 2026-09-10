package proxy

import (
	"context"
	"sync"

	"pulse/internal/store"
)

const interceptCapacity = 50

type iAction struct {
	req  *store.Request  // modified request (nil = forward unchanged)
	resp *store.Response // modified response (nil = forward unchanged)
	drop bool
}

type iItem struct {
	req  *store.Request  // the held request (or the context request for a held response)
	resp *store.Response // set when holding a response
	ch   chan iAction
}

// Intercept holds matching requests (and, optionally, responses) until the
// user forwards or drops them.
type Intercept struct {
	mu       sync.Mutex
	enabled  bool
	respOn   bool
	capacity int
	pending  map[string]*iItem
	order    []string

	// OnChange is invoked (outside the lock) whenever the queue changes.
	OnChange func()
}

func NewIntercept() *Intercept {
	return &Intercept{capacity: interceptCapacity, pending: map[string]*iItem{}}
}

func (it *Intercept) Enabled() bool {
	it.mu.Lock()
	defer it.mu.Unlock()
	return it.enabled
}

// SetEnabled toggles request interception; queued items stay held either way.
func (it *Intercept) SetEnabled(v bool) {
	it.mu.Lock()
	it.enabled = v
	it.mu.Unlock()
	it.changed()
}

func (it *Intercept) RespEnabled() bool {
	it.mu.Lock()
	defer it.mu.Unlock()
	return it.respOn
}

// SetRespEnabled toggles response interception (holds responses after the
// upstream reply, before they reach the client).
func (it *Intercept) SetRespEnabled(v bool) {
	it.mu.Lock()
	it.respOn = v
	it.mu.Unlock()
	it.changed()
}

func (it *Intercept) changed() {
	if it.OnChange != nil {
		it.OnChange()
	}
}

// Pending snapshots the queued requests in arrival order.
func (it *Intercept) Pending() []*store.Request {
	it.mu.Lock()
	defer it.mu.Unlock()
	out := make([]*store.Request, 0, len(it.order))
	for _, id := range it.order {
		if item := it.pending[id]; item != nil && item.resp == nil {
			cp := *item.req
			out = append(out, &cp)
		}
	}
	return out
}

// HeldResp is one held response with its request context for display.
type HeldResp struct {
	ID   string
	Req  *store.Request
	Resp *store.Response
}

// PendingResp snapshots held responses in arrival order.
func (it *Intercept) PendingResp() []HeldResp {
	it.mu.Lock()
	defer it.mu.Unlock()
	out := make([]HeldResp, 0, len(it.order))
	for _, id := range it.order {
		if item := it.pending[id]; item != nil && item.resp != nil {
			rq, rp := *item.req, *item.resp
			out = append(out, HeldResp{ID: id, Req: &rq, Resp: &rp})
		}
	}
	return out
}

// Hold blocks until the held request is forwarded or dropped, the context is
// canceled, or the client connection goes away. ok=false means give up.
// When the queue is full the oldest item is auto-forwarded unchanged so the
// proxy never stalls silently.
func (it *Intercept) Hold(ctx context.Context, req *store.Request) (forward *store.Request, ok bool) {
	it.mu.Lock()
	if !it.enabled {
		it.mu.Unlock()
		return req, true
	}
	item := &iItem{req: req, ch: make(chan iAction, 1)}
	it.enqueue(req.ID, item)
	it.mu.Unlock()
	it.changed()
	return it.await(ctx, item, req.ID)
}

// HoldResp holds a response (with its request for context) until forwarded
// or dropped. The id is "<reqID>-r" so it can't collide with held requests.
func (it *Intercept) HoldResp(ctx context.Context, req *store.Request, resp *store.Response) (forward *store.Response, ok bool) {
	id := req.ID + "-r"
	it.mu.Lock()
	if !it.respOn {
		it.mu.Unlock()
		return resp, true
	}
	item := &iItem{req: req, resp: resp, ch: make(chan iAction, 1)}
	it.enqueue(id, item)
	it.mu.Unlock()
	it.changed()

	it.mu.Lock()
	it.mu.Unlock()
	select {
	case a := <-item.ch:
		if a.drop {
			return nil, false
		}
		if a.resp != nil {
			return a.resp, true
		}
		return resp, true
	case <-ctx.Done():
		it.remove(id)
		it.changed()
		return nil, false
	}
}

func (it *Intercept) enqueue(id string, item *iItem) {
	it.pending[id] = item
	it.order = append(it.order, id)
	if len(it.order) > it.capacity {
		oldest := it.order[0]
		it.order = it.order[1:]
		if old := it.pending[oldest]; old != nil {
			delete(it.pending, oldest)
			old.ch <- iAction{req: old.req, resp: old.resp} // auto-forward
		}
	}
}

func (it *Intercept) await(ctx context.Context, item *iItem, id string) (*store.Request, bool) {
	select {
	case a := <-item.ch:
		if a.drop {
			return nil, false
		}
		if a.req != nil {
			return a.req, true
		}
		return item.req, true
	case <-ctx.Done():
		it.remove(id)
		it.changed()
		return nil, false
	}
}

func (it *Intercept) remove(id string) {
	it.mu.Lock()
	defer it.mu.Unlock()
	delete(it.pending, id)
	for i, x := range it.order {
		if x == id {
			it.order = append(it.order[:i], it.order[i+1:]...)
			break
		}
	}
}

// Forward releases the held request, optionally replacing it with mod.
func (it *Intercept) Forward(id string, mod *store.Request) bool {
	return it.resolve(id, iAction{req: mod})
}

// ForwardResp releases a held response, optionally replacing it with mod.
func (it *Intercept) ForwardResp(id string, mod *store.Response) bool {
	return it.resolve(id, iAction{resp: mod})
}

// Drop discards the held request (the client receives a 502).
func (it *Intercept) Drop(id string) bool {
	return it.resolve(id, iAction{drop: true})
}

func (it *Intercept) resolve(id string, a iAction) bool {
	it.mu.Lock()
	item := it.pending[id]
	if item != nil {
		delete(it.pending, id)
		for i, x := range it.order {
			if x == id {
				it.order = append(it.order[:i], it.order[i+1:]...)
				break
			}
		}
	}
	it.mu.Unlock()
	if item == nil {
		return false
	}
	item.ch <- a
	it.changed()
	return true
}
