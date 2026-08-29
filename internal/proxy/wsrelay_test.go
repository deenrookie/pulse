package proxy

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"pulse/internal/store"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

func acceptKey(key string) string {
	h := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h[:])
}

// writeClientFrame writes a masked client frame (clients must mask).
func writeClientFrame(w io.Writer, opcode byte, payload []byte) error {
	var head []byte
	head = append(head, 0x80|opcode)
	n := len(payload)
	switch {
	case n < 126:
		head = append(head, 0x80|byte(n))
	case n <= 0xFFFF:
		head = append(head, 0x80|126)
		var ext [2]byte
		binary.BigEndian.PutUint16(ext[:], uint16(n))
		head = append(head, ext[:]...)
	default:
		head = append(head, 0x80|127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		head = append(head, ext[:]...)
	}
	mask := [4]byte{0x11, 0x22, 0x33, 0x44}
	head = append(head, mask[:]...)
	masked := make([]byte, n)
	for i, b := range payload {
		masked[i] = b ^ mask[i%4]
	}
	_, err := w.Write(append(head, masked...))
	return err
}

// startWSEcho runs a real RFC 6455 echo server: proper handshake, echoes
// text/binary frames back unmasked.
func startWSEcho(t *testing.T) (addr string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				key := ""
				for {
					line, err := br.ReadString('\n')
					if err != nil {
						return
					}
					if strings.HasPrefix(strings.ToLower(line), "sec-websocket-key:") {
						key = strings.TrimSpace(strings.SplitN(line, ":", 2)[1])
					}
					if strings.TrimRight(line, "\r\n") == "" {
						break
					}
				}
				io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+acceptKey(key)+"\r\n\r\n")
				// echo every frame back (payload unmasked, FIN preserved)
				for {
					rawHead, fin, opcode, masked, mask, size, err := readFrameHeader(br)
					if err != nil {
						return
					}
					payload := make([]byte, size)
					if _, err := io.ReadFull(br, payload); err != nil {
						return
					}
					if masked {
						for i := range payload {
							payload[i] ^= mask[i%4]
						}
					}
					echoHead := []byte{rawHead[0] & 0x8F, byte(size)} // FIN|opcode, unmasked
					c.Write(echoHead)
					c.Write(payload)
					_ = fin
					_ = opcode
				}
			}(c)
		}
	}()
	return ln.Addr().String()
}

func TestWebSocketRelayRecordsFrames(t *testing.T) {
	up := startWSEcho(t)
	_, st, addr := newTestEngine(t, nil, nil)

	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close()
	key := "dGhlIHNhbXBsZSBub25jZQ=="
	req := "GET http://" + up + "/ws HTTP/1.1\r\n" +
		"Host: " + up + "\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := io.WriteString(conn, req); err != nil {
		t.Fatalf("write request: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil || !strings.Contains(status, "101") {
		t.Fatalf("status = %q err = %v, want 101", status, err)
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("read headers: %v", err)
		}
		if strings.TrimRight(line, "\r\n") == "" {
			break
		}
	}

	// client sends a text frame; echo returns it (s2c)
	if err := writeClientFrame(conn, 0x1, []byte("hello-pulse")); err != nil {
		t.Fatalf("write frame: %v", err)
	}
	// read the echoed frame: header (server→client is unmasked) + payload
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, echoOp, echoMasked, _, echoSize, err := readFrameHeader(br)
	if err != nil {
		t.Fatalf("read echo header: %v", err)
	}
	if echoOp != 0x1 || echoMasked {
		t.Fatalf("echo opcode=%#x masked=%v", echoOp, echoMasked)
	}
	echo := make([]byte, echoSize)
	if _, err := io.ReadFull(br, echo); err != nil {
		t.Fatalf("read echo payload: %v", err)
	}
	if string(echo) != "hello-pulse" {
		t.Fatalf("echo = %q", echo)
	}

	// let the throttled publish flush
	time.Sleep(700 * time.Millisecond)

	var wsFlow *store.Flow
	st.List("") // no All(); walk metas then fetch
	// find the /ws flow
	found := false
	for _, meta := range func() []store.FlowMeta { ms, _ := st.List(""); return ms }() {
		if fl, ok := st.Get(meta.ID); ok && len(fl.WSMessages) > 0 {
			wsFlow = fl
			found = true
			break
		}
	}
	_ = found
	if wsFlow == nil {
		t.Fatal("no flow recorded websocket messages")
	}
	if len(wsFlow.WSMessages) < 2 {
		t.Fatalf("messages = %d, want >= 2 (c2s + s2c)", len(wsFlow.WSMessages))
	}
	var gotC2S, gotS2C string
	for _, m := range wsFlow.WSMessages {
		if m.Dir == "c2s" && m.Opcode == "text" {
			gotC2S = string(m.Data)
		}
		if m.Dir == "s2c" && m.Opcode == "text" {
			gotS2C = string(m.Data)
		}
	}
	if gotC2S != "hello-pulse" {
		t.Fatalf("c2s payload = %q", gotC2S)
	}
	if gotS2C != "hello-pulse" {
		t.Fatalf("s2c payload = %q", gotS2C)
	}
}
