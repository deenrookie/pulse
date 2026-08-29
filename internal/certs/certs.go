// Package certs manages the Pulse root CA and on-the-fly leaf certificates
// used for HTTPS interception.
package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	leafTTL    = 24 * time.Hour
	leafRotate = 1 * time.Hour // regenerate when less than this remains
	cacheCap   = 1024
)

// Authority signs interception leaf certificates with a persistent root CA.
type Authority struct {
	cert   *x509.Certificate
	key    *ecdsa.PrivateKey
	tlsCert tls.Certificate

	mu    sync.Mutex
	cache map[string]*tls.Certificate
	order []string // simple LRU eviction order
}

// LoadOrCreate reads ca.pem/ca-key.pem from dir, generating them on first run.
func LoadOrCreate(dir string) (*Authority, error) {
	certPath := filepath.Join(dir, "ca.pem")
	keyPath := filepath.Join(dir, "ca-key.pem")

	if _, err := os.Stat(certPath); err == nil {
		if _, err := os.Stat(keyPath); err == nil {
			return loadFrom(certPath, keyPath)
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	a, err := generate()
	if err != nil {
		return nil, err
	}
	if err := a.saveTo(certPath, keyPath); err != nil {
		return nil, err
	}
	return a, nil
}

func loadFrom(certPath, keyPath string) (*Authority, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, fmt.Errorf("read CA cert: %w", err)
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("read CA key: %w", err)
	}
	certDER, _ := pem.Decode(certPEM)
	if certDER == nil || certDER.Type != "CERTIFICATE" {
		return nil, errors.New("ca.pem is not a valid certificate")
	}
	keyDER, _ := pem.Decode(keyPEM)
	if keyDER == nil || keyDER.Type != "EC PRIVATE KEY" {
		return nil, errors.New("ca-key.pem is not a valid EC private key")
	}
	cert, err := x509.ParseCertificate(certDER.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse CA cert: %w", err)
	}
	key, err := x509.ParseECPrivateKey(keyDER.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse CA key: %w", err)
	}
	tlsCert := tls.Certificate{Certificate: [][]byte{cert.Raw}, PrivateKey: key}
	return &Authority{cert: cert, key: key, tlsCert: tlsCert, cache: map[string]*tls.Certificate{}}, nil
}

func generate() (*Authority, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate CA key: %w", err)
	}
	serial, err := randSerial()
	if err != nil {
		return nil, err
	}
	tpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "Pulse CA",
			Organization: []string{"Pulse"},
		},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("create CA cert: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("parse CA cert: %w", err)
	}
	return &Authority{cert: cert, key: key, tlsCert: tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, cache: map[string]*tls.Certificate{}}, nil
}

func (a *Authority) saveTo(certPath, keyPath string) error {
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: a.cert.Raw})
	keyDER, err := x509.MarshalECPrivateKey(a.key)
	if err != nil {
		return fmt.Errorf("marshal CA key: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return fmt.Errorf("write CA cert: %w", err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return fmt.Errorf("write CA key: %w", err)
	}
	return nil
}

// Leaf returns a TLS certificate for host (DNS name or IP literal), reusing a
// cached one while it stays valid.
func (a *Authority) Leaf(host string) (*tls.Certificate, error) {
	if host == "" {
		host = "unknown.invalid"
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if c, ok := a.cache[host]; ok {
		if time.Now().Before(c.Leaf.NotAfter.Add(-leafRotate)) {
			return c, nil
		}
		delete(a.cache, host)
	}
	c, err := a.signLeaf(host)
	if err != nil {
		return nil, err
	}
	if len(a.order) >= cacheCap {
		delete(a.cache, a.order[0])
		a.order = a.order[1:]
	}
	a.cache[host] = c
	a.order = append(a.order, host)
	return c, nil
}

func (a *Authority) signLeaf(host string) (*tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate leaf key: %w", err)
	}
	serial, err := randSerial()
	if err != nil {
		return nil, err
	}
	tpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: host, Organization: []string{"Pulse"}},
		NotBefore:    time.Now().Add(-5 * time.Minute),
		NotAfter:     time.Now().Add(leafTTL),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
	}
	if ip := net.ParseIP(host); ip != nil {
		tpl.IPAddresses = []net.IP{ip}
	} else {
		tpl.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, a.cert, &key.PublicKey, a.key)
	if err != nil {
		return nil, fmt.Errorf("create leaf cert: %w", err)
	}
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	if cert.Leaf, err = x509.ParseCertificate(der); err != nil {
		return nil, fmt.Errorf("parse leaf cert: %w", err)
	}
	return &cert, nil
}

// CACert returns the root certificate.
func (a *Authority) CACert() *x509.Certificate { return a.cert }

// CAPool returns a pool containing only the Pulse root.
func (a *Authority) CAPool() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(a.cert)
	return pool
}

// Fingerprint returns the SHA-256 fingerprint of the root certificate.
func (a *Authority) Fingerprint() string {
	sum := sha256.Sum256(a.cert.Raw)
	hex := fmt.Sprintf("%X", sum)
	out := make([]byte, 0, len(hex)+len(hex)/2)
	for i := 0; i < len(hex); i += 2 {
		if i > 0 {
			out = append(out, ':')
		}
		out = append(out, hex[i], hex[i+1])
	}
	return "SHA256:" + string(out)
}

// PEM returns the root certificate in PEM form (for download).
func (a *Authority) PEM() []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: a.cert.Raw})
}

func randSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	return rand.Int(rand.Reader, limit)
}
