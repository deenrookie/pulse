package certs

import (
	"crypto/x509"
	"encoding/pem"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadOrCreateAndLeafChain(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	leaf, err := a.Leaf("example.com")
	if err != nil {
		t.Fatalf("Leaf: %v", err)
	}
	cert := leaf.Leaf
	if got := cert.DNSNames; len(got) != 1 || got[0] != "example.com" {
		t.Fatalf("DNSNames = %v, want [example.com]", got)
	}
	if _, err := cert.Verify(x509.VerifyOptions{Roots: a.CAPool(), CurrentTime: time.Now()}); err != nil {
		t.Fatalf("leaf does not verify against CA: %v", err)
	}
	if time.Until(cert.NotAfter) > leafTTL+time.Minute {
		t.Fatalf("leaf validity %v exceeds ttl", time.Until(cert.NotAfter))
	}

	ipLeaf, err := a.Leaf("127.0.0.1")
	if err != nil {
		t.Fatalf("Leaf(ip): %v", err)
	}
	if got := ipLeaf.Leaf.IPAddresses; len(got) != 1 || got[0].String() != "127.0.0.1" {
		t.Fatalf("IPAddresses = %v, want [127.0.0.1]", got)
	}

	// cached leaf must be the same object on second call
	again, _ := a.Leaf("example.com")
	if again != leaf {
		t.Fatal("expected cached leaf instance")
	}
}

func TestReloadFromDisk(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	b, err := LoadOrCreate(filepath.Join(dir)) // same dir, files exist now
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if a.Fingerprint() != b.Fingerprint() {
		t.Fatal("reloaded CA fingerprint differs")
	}
	// leaf signed by reloaded CA must verify against original CA pool
	leaf, err := b.Leaf("reload.test")
	if err != nil {
		t.Fatalf("Leaf: %v", err)
	}
	if _, err := leaf.Leaf.Verify(x509.VerifyOptions{Roots: a.CAPool(), CurrentTime: time.Now()}); err != nil {
		t.Fatalf("cross-verify failed: %v", err)
	}
}

func TestPEM(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	block, _ := pem.Decode(a.PEM())
	if block == nil || block.Type != "CERTIFICATE" {
		t.Fatal("PEM() did not produce a certificate")
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		t.Fatalf("PEM bytes not a certificate: %v", err)
	}
}
