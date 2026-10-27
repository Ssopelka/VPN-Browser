package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestIsNewer(t *testing.T) {
	cases := []struct {
		latest, cur string
		want        bool
	}{
		{"v2.0.30", "v2.0.29", true},
		{"v2.0.29", "v2.0.29", false},
		{"v2.0.9", "v2.0.29", false},
		{"v2.1.0", "v2.0.99", true},
		{"v2.0.30", "dev", false},
		{"garbage", "v2.0.1", false},
	}
	for _, c := range cases {
		if got := isNewer(c.latest, c.cur); got != c.want {
			t.Errorf("isNewer(%q, %q) = %v, want %v", c.latest, c.cur, got, c.want)
		}
	}
}

func TestParseSums(t *testing.T) {
	h := hex.EncodeToString(make([]byte, 32))
	text := h + "  vpn-terminal-linux-x64\n" + h[:63] + "a *other\n"
	if parseSums(text, "vpn-terminal-linux-x64") != h {
		t.Fatal("hash not found")
	}
	if parseSums(text, "other") != h[:63]+"a" {
		t.Fatal("binary-mode entry not found")
	}
	if parseSums(text, "missing") != "" {
		t.Fatal("unexpected match")
	}
}

func TestDownloadVerified(t *testing.T) {
	body := []byte("binary-content")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	defer srv.Close()
	old := releaseDL
	releaseDL = srv.URL + "/"
	defer func() { releaseDL = old }()

	sum := sha256.Sum256(body)
	dst := filepath.Join(t.TempDir(), "bin")
	if err := downloadVerified(srv.URL+"/x", dst, hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != string(body) {
		t.Fatal("content mismatch")
	}
	if err := downloadVerified(srv.URL+"/x", dst, hex.EncodeToString(make([]byte, 32))); err == nil {
		t.Fatal("bad checksum accepted")
	}
	if _, err := os.Stat(dst); err == nil {
		t.Fatal("file with bad checksum left on disk")
	}
	if err := downloadVerified("https://evil.example/x", dst, "00"); err == nil {
		t.Fatal("foreign url accepted")
	}
}
