package main

import (
	"fmt"
	"os"
	"sync"
	"time"
)

type startMsg struct {
	Cmd    string `json:"cmd"`
	URL    string `json:"url"`
	Port   int    `json:"port"`
	Server string `json:"server"`
}

func runHost() {
	nm := &nmConn{in: os.Stdin, out: os.Stdout}
	var (
		mu  sync.Mutex
		cur *core
	)
	stop := func() {
		mu.Lock()
		c := cur
		cur = nil
		mu.Unlock()
		c.stop()
	}
	defer stop()

	go func() {
		for range time.Tick(time.Second) {
			mu.Lock()
			c := cur
			mu.Unlock()
			if c != nil {
				up, down := c.stats()
				_ = nm.send(obj{"event": "stats", "up": up, "down": down})
			}
		}
	}()

	for {
		var m startMsg
		if err := nm.read(&m); err != nil {
			return
		}
		switch m.Cmd {
		case "stop":
			stop()
		case "servers":
			servers, err := resolveServers(m.URL, func(string) {})
			if err != nil {
				_ = nm.send(obj{"event": "error", "message": err.Error()})
				continue
			}
			_ = nm.send(obj{"event": "servers", "servers": servers})
		case "start":
			stop()
			c, err := startCore(m.URL, m.Port, m.Server, func(s string) { _ = nm.send(obj{"event": "progress", "message": s}) })
			if err != nil {
				_ = nm.send(obj{"event": "error", "message": err.Error()})
				continue
			}
			mu.Lock()
			cur = c
			mu.Unlock()
			_ = nm.send(obj{"event": "servers", "servers": c.Servers})
			_ = nm.send(obj{"event": "started", "server": c.Server, "protocol": c.Proto, "port": c.Port, "user": c.User, "pass": c.Pass})
			go func(c *core) {
				d, err := c.health()
				if err != nil {
					_ = nm.send(obj{"event": "health", "ok": false, "message": fmt.Sprint(err)})
					return
				}
				_ = nm.send(obj{"event": "health", "ok": true, "ms": d.Milliseconds()})
			}(c)
		}
	}
}
