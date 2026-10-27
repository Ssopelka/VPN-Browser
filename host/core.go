package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/common/trafficcontrol"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/json"
	"github.com/sagernet/sing/service"
)

const maxSubscription = 5 << 20

type core struct {
	cancel   context.CancelFunc
	instance *box.Box
	traffic  *trafficcontrol.Manager
	Port     int
	User     string
	Pass     string
	Server   string
	Proto    string
	Servers  []serverInfo
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func freePort(want int) (int, error) {
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", want))
	if err != nil {
		if want == 0 {
			return 0, err
		}
		return freePort(0)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func fetchText(src string) (string, error) {
	u, err := url.Parse(src)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errors.New("некорректный адрес подписки")
	}
	req, _ := http.NewRequest("GET", src, nil)
	req.Header.Set("User-Agent", "v2rayN/6.0")
	cl := &http.Client{Timeout: 25 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return "", fmt.Errorf("не удалось загрузить подписку: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("подписка вернула HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxSubscription+1))
	if err != nil {
		return "", err
	}
	if len(b) > maxSubscription {
		return "", errors.New("подписка слишком большая")
	}
	return string(b), nil
}

func buildConfig(link string, port int, user, pass string) ([]byte, string, string, error) {
	ob, name, err := parseLink(link)
	if err != nil {
		return nil, "", "", err
	}
	ob["tag"] = "proxy"
	typ, _ := ob["type"].(string)
	cfg := obj{
		"log": obj{"level": "warn"},
		"inbounds": []obj{{
			"type": "mixed", "tag": "in", "listen": "127.0.0.1", "listen_port": port,
			"users": []obj{{"username": user, "password": pass}},
		}},
		"outbounds": []obj{ob, {"type": "direct", "tag": "direct"}},
		"route":     obj{"final": "proxy", "default_domain_resolver": "local"},
		"dns":       obj{"servers": []obj{{"type": "local", "tag": "local"}}},
	}
	b, err := json.Marshal(cfg)
	return b, name, typ, err
}

func resolveServers(src string, progress func(string)) ([]serverInfo, error) {
	src = strings.TrimSpace(src)
	body := src
	if l := strings.ToLower(src); strings.HasPrefix(l, "http://") || strings.HasPrefix(l, "https://") {
		progress("Загружаю конфиг…")
		var err error
		if body, err = fetchText(src); err != nil {
			return nil, err
		}
	}
	links, err := selectLinks(body)
	if err != nil {
		return nil, err
	}
	servers := parseServers(links)
	if len(servers) == 0 {
		_, _, err := parseLink(links[0])
		return nil, err
	}
	return servers, nil
}

func startCore(src string, wantPort int, want string, progress func(string)) (*core, error) {
	servers, err := resolveServers(src, progress)
	if err != nil {
		return nil, err
	}
	pick, _ := chooseServer(servers, want)
	link := pick.link
	port, err := freePort(wantPort)
	if err != nil {
		return nil, err
	}
	c := &core{Port: port, User: randHex(8), Pass: randHex(16), Servers: servers}
	cfg, name, typ, err := buildConfig(link, port, c.User, c.Pass)
	if err != nil {
		return nil, err
	}
	c.Server, c.Proto = name, typ

	progress("Запуск ядра…")
	ctx := boxContext(context.Background())
	var opts option.Options
	if err := opts.UnmarshalJSONContext(ctx, cfg); err != nil {
		return nil, fmt.Errorf("конфиг ядра: %w", err)
	}
	ctx, cancel := context.WithCancel(service.ExtendContext(ctx))
	inst, err := box.New(box.Options{Context: ctx, Options: opts})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("ядро: %w", err)
	}
	c.traffic = trafficcontrol.NewManager()
	inst.Router().AppendTracker(c.traffic)
	if err := inst.Start(); err != nil {
		cancel()
		_ = inst.Close()
		return nil, fmt.Errorf("ядро не запустилось: %w", err)
	}
	c.instance, c.cancel = inst, cancel
	return c, nil
}

func (c *core) stats() (up, down int64) { return c.traffic.Total() }

func (c *core) stop() {
	if c == nil {
		return
	}
	c.cancel()
	_ = c.instance.Close()
}

func (c *core) health() (time.Duration, error) {
	pu := &url.URL{Scheme: "http", User: url.UserPassword(c.User, c.Pass), Host: fmt.Sprintf("127.0.0.1:%d", c.Port)}
	cl := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(pu)}}
	defer cl.CloseIdleConnections()
	t := time.Now()
	resp, err := cl.Get("https://cp.cloudflare.com/generate_204")
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return time.Since(t), nil
}
