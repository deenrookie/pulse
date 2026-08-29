// Package events provides a small fan-out bus for server-sent events.
package events

import "sync"

// Event is one SSE frame: a named event with a pre-marshaled JSON payload.
type Event struct {
	Name string
	Data []byte
}

// Bus distributes events to subscribed SSE streams.
type Bus struct {
	mu   sync.Mutex
	subs map[chan Event]struct{}
}

func NewBus() *Bus {
	return &Bus{subs: map[chan Event]struct{}{}}
}

// Subscribe returns a buffered channel of events plus a cancel function.
func (b *Bus) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 64)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	cancel := func() {
		b.mu.Lock()
		if _, ok := b.subs[ch]; ok {
			delete(b.subs, ch)
			close(ch)
		}
		b.mu.Unlock()
	}
	return ch, cancel
}

// Publish delivers ev to every subscriber; slow subscribers drop events
// rather than block the proxy engine.
func (b *Bus) Publish(ev Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// Count reports the number of active subscribers.
func (b *Bus) Count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}
