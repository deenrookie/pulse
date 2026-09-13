package events

import "testing"

func TestDrainDropsQueuedEvents(t *testing.T) {
	bus := NewBus()
	ch, cancel := bus.Subscribe()
	defer cancel()
	for i := 0; i < 10; i++ {
		bus.Publish(Event{Name: "flow", Data: []byte{byte(i)}})
	}
	if len(ch) != 10 {
		t.Fatalf("queued = %d, want 10", len(ch))
	}
	bus.Drain()
	if len(ch) != 0 {
		t.Fatalf("after drain queued = %d, want 0", len(ch))
	}
	// still delivers after draining
	bus.Publish(Event{Name: "flow", Data: []byte{9}})
	if len(ch) != 1 {
		t.Fatalf("post-drain delivery broken: %d", len(ch))
	}
}
