// Transparent WebSocket relay: splices an upgraded connection like tunnel()
// does, but parses RFC 6455 frames as they pass and records completed
// messages into the flow (capped, throttled persistence + SSE publishing).
// Forwarding is byte-exact; parsing is observational only.
package proxy

import (
	"bufio"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"pulse/internal/store"
)

const (
	wsMaxDataPerMsg = 64 * 1024  // stored payload cap per message
	wsMaxMessages   = 1000       // stored message cap per flow
	wsPublishEvery  = 400 * time.Millisecond
	wsChunk         = 32 * 1024  // payload copy granularity
)

// isWebSocketUpgrade reports a genuine RFC 6455 handshake: an
// Upgrade: websocket request carrying Sec-WebSocket-Key answered with
// Sec-WebSocket-Accept. Anything else (bare Upgrade headers, other
// protocols) keeps the blind tunnel.
func isWebSocketUpgrade(req *store.Request, resp *store.Response) bool {
	upgrades := false
	keyed := false
	for _, h := range req.Headers {
		if strings.EqualFold(h.Name, "Upgrade") {
			if strings.EqualFold(h.Value, "websocket") {
				upgrades = true
			} else {
				return false
			}
		}
		if strings.EqualFold(h.Name, "Sec-WebSocket-Key") {
			keyed = true
		}
	}
	if !upgrades || !keyed || resp == nil {
		return false
	}
	for _, h := range resp.Headers {
		if strings.EqualFold(h.Name, "Sec-WebSocket-Accept") {
			return true
		}
	}
	return false
}

// wsSink serializes message appends and throttles store/SSE updates.
type wsSink struct {
	mu       sync.Mutex
	msgs     []store.WSMessage
	fl       *store.Flow
	store    *store.Store
	publish  func(name string, fl *store.Flow)
	lastPub  time.Time
	trailing bool
}

func (s *wsSink) add(m store.WSMessage) {
	s.mu.Lock()
	if len(s.msgs) < wsMaxMessages {
		s.msgs = append(s.msgs, m)
	}
	shouldPub := time.Since(s.lastPub) >= wsPublishEvery
	var snapshot []store.WSMessage
	if shouldPub {
		s.lastPub = time.Now()
		snapshot = s.snapshotLocked()
	} else if !s.trailing {
		// throttled: schedule one trailing flush so the tail is not held back
		s.trailing = true
		time.AfterFunc(wsPublishEvery, func() {
			s.mu.Lock()
			s.trailing = false
			s.lastPub = time.Now()
			snapshot := s.snapshotLocked()
			s.mu.Unlock()
			s.flush(snapshot)
		})
	}
	s.mu.Unlock()
	if shouldPub {
		s.flush(snapshot)
	}
}

// snapshotLocked copies the message slice; payloads are never mutated after
// append, so sharing the byte slices is safe.
func (s *wsSink) snapshotLocked() []store.WSMessage {
	out := make([]store.WSMessage, len(s.msgs))
	copy(out, s.msgs)
	return out
}

// flush publishes a snapshot onto a shallow flow clone (stable slice).
func (s *wsSink) flush(snapshot []store.WSMessage) {
	fl := *s.fl
	fl.WSMessages = snapshot
	_ = s.store.Update(&fl)
	s.publish("flow_update", &fl)
}

func (s *wsSink) close() {
	s.mu.Lock()
	snapshot := s.snapshotLocked()
	s.mu.Unlock()
	if len(snapshot) > 0 {
		s.flush(snapshot)
	}
}

// relayWS splices client (a) and upstream (b), parsing frames in both
// directions. Bytes reach the other side unchanged.
func (e *Engine) relayWS(a net.Conn, abr *bufio.Reader, b net.Conn, bbr *bufio.Reader, fl *store.Flow) {
	defer a.Close()
	defer b.Close()
	sink := &wsSink{fl: fl, store: e.store, publish: e.publishFlow}
	done := make(chan struct{}, 2)
	go func() {
		wsPump(b, abr, "c2s", sink) // client → upstream (masked)
		done <- struct{}{}
	}()
	go func() {
		wsPump(a, bbr, "s2c", sink) // upstream → client
		done <- struct{}{}
	}()
	<-done
	a.Close()
	b.Close()
	sink.close()
}

// wsPump relays whole frames from the reader to dst, recording completed
// data messages. Fragmented messages are assembled per direction.
func wsPump(dst io.Writer, r *bufio.Reader, dir string, sink *wsSink) {
	var fragOp string    // opcode of the message being assembled
	var frag []byte      // capped payload buffer of the fragments so far
	var fragSize int     // true (uncapped) size of the message so far

	for {
		rawHead, fin, opcode, masked, mask, size64, err := readFrameHeader(r)
		if err != nil {
			// not parseable as frames (or EOF). Degrade gracefully: relay the
			// buffered bytes and everything after them transparently, so
			// non-conforming or half-broken upgrades keep flowing.
			spool(dst, r)
			return
		}
		size := int(size64)
		if _, err := dst.Write(rawHead); err != nil {
			return
		}

		// stream the payload chunk by chunk: forward verbatim, unmask into a
		// capped accumulator, so huge frames never balloon memory
		capped := newCappedAccum(&frag)
		remaining := size
		maskIdx := 0
		for remaining > 0 {
			n := wsChunk
			if remaining < n {
				n = remaining
			}
			raw := make([]byte, n)
			if _, err := io.ReadFull(r, raw); err != nil {
				spool(dst, r)
				return
			}
			// forward the wire bytes verbatim; unmask only the recorded copy
			if _, err := dst.Write(raw); err != nil {
				return
			}
			if opcode == 0x1 || opcode == 0x2 || opcode == 0x0 {
				plain := raw
				if masked {
					plain = make([]byte, n)
					copy(plain, raw)
					for i := range plain {
						plain[i] ^= mask[(maskIdx+i)%4]
					}
				}
				capped.add(plain)
			}
			maskIdx += int(n)
			remaining -= n
		}

		switch opcode {
		case 0x8, 0x9, 0xA: // close / ping / pong — control frames are always FIN
			data, trunc := capped.take()
			sink.add(store.WSMessage{Dir: dir, Opcode: wsOpName(opcode), Size: size, Data: data, Truncated: trunc, At: time.Now()})
		case 0x1, 0x2:
			if fin {
				data, trunc := capped.take()
				sink.add(store.WSMessage{Dir: dir, Opcode: wsOpName(opcode), Size: size, Data: data, Truncated: trunc, At: time.Now()})
			} else {
				fragOp = wsOpName(opcode)
				fragSize = size
				capped.keep()
			}
		case 0x0: // continuation
			fragSize += size
			if fin {
				data, trunc := capped.take()
				sink.add(store.WSMessage{Dir: dir, Opcode: fragOp, Size: fragSize, Data: data, Truncated: trunc, At: time.Now()})
				fragOp = ""
				fragSize = 0
			} else {
				capped.keep()
			}
		default:
			// unknown opcode: forwarded, not recorded
		}
	}
}

// readFrameHeader consumes and returns the raw header bytes plus fields.
func readFrameHeader(r *bufio.Reader) (raw []byte, fin bool, opcode byte, masked bool, mask [4]byte, size int64, err error) {
	var head [2]byte
	if _, err = io.ReadFull(r, head[:]); err != nil {
		return
	}
	raw = append(raw, head[:]...)
	fin = head[0]&0x80 != 0
	opcode = head[0] & 0x0F
	masked = head[1]&0x80 != 0
	len7 := int64(head[1] & 0x7F)
	size = len7
	if len7 == 126 {
		var ext [2]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return
		}
		raw = append(raw, ext[:]...)
		size = int64(binary.BigEndian.Uint16(ext[:]))
	} else if len7 == 127 {
		var ext [8]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return
		}
		raw = append(raw, ext[:]...)
		size = int64(binary.BigEndian.Uint64(ext[:]))
		if size < 0 {
			err = io.ErrUnexpectedEOF
			return
		}
	}
	if masked {
		if _, err = io.ReadFull(r, mask[:]); err != nil {
			return
		}
		raw = append(raw, mask[:]...)
	}
	return
}

// cappedAccum accumulates payload bytes up to wsMaxDataPerMsg, then reports
// truncation while discarding the rest.
type cappedAccum struct {
	buf       *[]byte
	truncated bool
	keepBuf   bool
}

func newCappedAccum(shared *[]byte) *cappedAccum {
	return &cappedAccum{buf: shared}
}

func (c *cappedAccum) add(p []byte) {
	if len(*c.buf)+len(p) > wsMaxDataPerMsg {
		fit := wsMaxDataPerMsg - len(*c.buf)
		if fit > 0 {
			*c.buf = append(*c.buf, p[:fit]...)
		}
		c.truncated = true
		return
	}
	*c.buf = append(*c.buf, p...)
}

// take returns the accumulated (capped) payload; the accumulator detaches
// from the shared buffer, leaving it empty for the next message.
func (c *cappedAccum) take() ([]byte, bool) {
	out := *c.buf
	*c.buf = nil
	return out, c.truncated
}

// keep leaves the accumulated bytes in place for continuation frames.
func (c *cappedAccum) keep() {}

func wsOpName(op byte) string {
	switch op {
	case 0x1:
		return "text"
	case 0x2:
		return "binary"
	case 0x8:
		return "close"
	case 0x9:
		return "ping"
	case 0xA:
		return "pong"
	}
	return "unknown"
}
