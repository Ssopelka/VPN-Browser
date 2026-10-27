package main

import (
	"bytes"
	"testing"

	app "github.com/Ssopelka/VPN-Browser"
)

func TestFraming(t *testing.T) {
	var buf bytes.Buffer
	c := &nmConn{in: &buf, out: &buf}
	if err := c.send(obj{"event": "x", "n": 1}); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := c.read(&got); err != nil || got["event"] != "x" {
		t.Fatalf("%v %v", got, err)
	}
	buf.Write([]byte{0xff, 0xff, 0xff, 0x7f})
	if err := c.read(&got); err == nil {
		t.Fatal("ожидалась ошибка размера")
	}
}

func TestEmbeddedExtension(t *testing.T) {
	b, err := app.Extension.ReadFile("extension/manifest.json")
	if err != nil || len(b) == 0 {
		t.Fatalf("расширение не вшито в exe: %v", err)
	}
}
