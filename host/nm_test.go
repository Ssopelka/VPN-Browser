package main

import (
	"bytes"
	"testing"
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
	// слишком большое сообщение отклоняется до выделения памяти
	buf.Write([]byte{0xff, 0xff, 0xff, 0x7f})
	if err := c.read(&got); err == nil {
		t.Fatal("ожидалась ошибка размера")
	}
}
