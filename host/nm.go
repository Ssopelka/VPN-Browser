package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

// Протокол native messaging: 4 байта длины (little-endian) + JSON.
const maxIncoming = 1 << 20

type nmConn struct {
	in  io.Reader
	out io.Writer
	mu  sync.Mutex
}

func (c *nmConn) read(v any) error {
	var hdr [4]byte
	if _, err := io.ReadFull(c.in, hdr[:]); err != nil {
		return err
	}
	n := binary.LittleEndian.Uint32(hdr[:])
	if n > maxIncoming {
		return errors.New("сообщение слишком большое")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(c.in, buf); err != nil {
		return err
	}
	return json.Unmarshal(buf, v)
}

// send безопасен для вызова из нескольких горутин. В stdout нельзя писать ничего, кроме сообщений протокола.
func (c *nmConn) send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(b)))
	if _, err := c.out.Write(hdr[:]); err != nil {
		return err
	}
	_, err = c.out.Write(b)
	return err
}
