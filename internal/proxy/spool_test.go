package proxy

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

func TestSpoolBufferedPrefixExactlyOnce(t *testing.T) {
	source := strings.Repeat("upgraded-traffic-", 1024)
	reader := bufio.NewReaderSize(strings.NewReader(source), 32)
	if _, err := reader.Peek(12); err != nil {
		t.Fatal(err)
	}
	var destination bytes.Buffer
	spool(&destination, reader)
	if destination.String() != source {
		t.Fatalf("tunnel bytes changed: got %d, want %d", destination.Len(), len(source))
	}
}
