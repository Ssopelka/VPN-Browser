package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Схемы, которые умеем превращать в outbound sing-box.
var schemes = []string{"vless", "vmess", "trojan", "ss", "hysteria2", "hy2", "hysteria", "tuic", "anytls", "socks", "socks5"}

type obj = map[string]any

func unesc(s string) string {
	if v, err := url.PathUnescape(s); err == nil {
		return v
	}
	return s
}

func b64Decode(s string) (string, error) {
	s = strings.TrimSpace(s)
	s = strings.NewReplacer("-", "+", "_", "/", "=", "").Replace(s)
	b, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func truthy(v string) bool {
	switch strings.ToLower(v) {
	case "1", "true", "yes":
		return true
	}
	return false
}

func parseQuery(q string) map[string]string {
	h := map[string]string{}
	for _, kv := range strings.Split(q, "&") {
		if kv == "" {
			continue
		}
		k, v, _ := strings.Cut(kv, "=")
		k = unesc(k)
		if _, ok := h[k]; !ok {
			h[k] = unesc(v)
		}
	}
	return h
}

type link struct {
	rawUser, user, pass string
	hasPass             bool
	server              string
	port                int
	query               map[string]string
	name                string
}

var linkRe = regexp.MustCompile(`^(?P<s>[A-Za-z0-9+.-]+)://(?:(?P<u>[^@/?#]*)@)?(?P<h>\[[^\]]+\]|[^:/?#]*)(?::(?P<p>\d+))?(?P<path>/[^?#]*)?(?:\?(?P<q>[^#]*))?(?:#(?P<f>.*))?$`)
var linkReLoose = regexp.MustCompile(`^(?P<s>[A-Za-z0-9+.-]+)://(?:(?P<u>[^@]*)@)?(?P<h>\[[^\]]+\]|[^:/?#]*)(?::(?P<p>\d+))?(?P<path>/[^?#]*)?(?:\?(?P<q>[^#]*))?(?:#(?P<f>.*))?$`)

func splitLink(raw string, loose bool) (*link, error) {
	re := linkRe
	if loose {
		re = linkReLoose
	}
	m := re.FindStringSubmatch(raw)
	if m == nil {
		return nil, errors.New("не удалось разобрать ссылку")
	}
	g := func(n string) string { return m[re.SubexpIndex(n)] }
	l := &link{rawUser: g("u"), query: parseQuery(g("q"))}
	l.user = unesc(l.rawUser)
	if i := strings.Index(l.rawUser, ":"); i >= 0 {
		l.user, l.pass, l.hasPass = unesc(l.rawUser[:i]), unesc(l.rawUser[i+1:]), true
	}
	l.server = strings.Trim(g("h"), "[]")
	if p := g("p"); p != "" {
		l.port, _ = strconv.Atoi(p)
	}
	l.name = l.server
	if f := g("f"); f != "" {
		l.name = unesc(f)
	}
	return l, nil
}

func qget(q map[string]string, key string, def ...string) string {
	if v := q[key]; v != "" {
		return v
	}
	if len(def) > 0 {
		return def[0]
	}
	return ""
}

func newTLS(q map[string]string, srv string, defaultOn bool) obj {
	sec := "none"
	if v, ok := q["security"]; ok {
		sec = v
	} else if defaultOn {
		sec = "tls"
	}
	if sec != "tls" && sec != "reality" && sec != "xtls" {
		return nil
	}
	t := obj{"enabled": true, "server_name": qget(q, "sni", qget(q, "peer", srv))}
	if alpn := qget(q, "alpn"); alpn != "" {
		var a []string
		for _, x := range strings.Split(alpn, ",") {
			if x != "" {
				a = append(a, x)
			}
		}
		t["alpn"] = a
	}
	if truthy(qget(q, "allowInsecure")) || truthy(qget(q, "insecure")) {
		t["insecure"] = true
	}
	fp := qget(q, "fp")
	if fp != "" || sec == "reality" {
		if fp == "" {
			fp = "chrome"
		}
		t["utls"] = obj{"enabled": true, "fingerprint": fp}
	}
	if sec == "reality" {
		t["reality"] = obj{"enabled": true, "public_key": qget(q, "pbk"), "short_id": qget(q, "sid")}
	}
	return t
}

func newTransport(q map[string]string) (obj, error) {
	net := qget(q, "type", "tcp")
	path := qget(q, "path", "/")
	host := qget(q, "host")
	switch net {
	case "tcp", "raw":
		return nil, nil
	case "ws":
		t := obj{"type": "ws", "path": path}
		if host != "" {
			t["headers"] = obj{"Host": host}
		}
		return t, nil
	case "grpc":
		return obj{"type": "grpc", "service_name": qget(q, "serviceName", qget(q, "path"))}, nil
	case "http", "h2":
		t := obj{"type": "http", "path": path}
		if host != "" {
			t["host"] = strings.Split(host, ",")
		}
		return t, nil
	case "httpupgrade":
		return obj{"type": "httpupgrade", "path": path, "host": host}, nil
	}
	return nil, fmt.Errorf("транспорт «%s» не поддерживается ядром sing-box", net)
}

func addTLSTransport(ob obj, q map[string]string, srv string, defaultTLS bool) (obj, error) {
	if t := newTLS(q, srv, defaultTLS); t != nil {
		ob["tls"] = t
	}
	tr, err := newTransport(q)
	if err != nil {
		return nil, err
	}
	if tr != nil {
		ob["transport"] = tr
	}
	return ob, nil
}

func anyStr(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

// parseLink превращает ссылку (vless://, vmess://, ...) в outbound sing-box и отображаемое имя.
func parseLink(raw string) (obj, string, error) {
	raw = strings.TrimSpace(raw)
	i := strings.Index(raw, "://")
	if i <= 0 {
		return nil, "", errors.New("не удалось разобрать ссылку")
	}
	scheme := strings.ToLower(raw[:i])

	if scheme == "vmess" {
		body, _, _ := strings.Cut(raw[8:], "#")
		dec, err := b64Decode(body)
		if err != nil {
			return nil, "", errors.New("vmess: некорректный base64")
		}
		var j map[string]any
		if err := json.Unmarshal([]byte(dec), &j); err != nil {
			return nil, "", errors.New("vmess: некорректный JSON")
		}
		tlsOn := anyStr(j["tls"]) == "tls" || anyStr(j["tls"]) == "reality"
		sec := "none"
		if tlsOn {
			sec = "tls"
		}
		q := map[string]string{
			"type": anyStr(j["net"]), "path": anyStr(j["path"]), "host": anyStr(j["host"]), "sni": anyStr(j["sni"]),
			"alpn": anyStr(j["alpn"]), "fp": anyStr(j["fp"]), "serviceName": anyStr(j["path"]), "security": sec,
		}
		port, _ := strconv.Atoi(anyStr(j["port"]))
		aid, _ := strconv.Atoi(anyStr(j["aid"]))
		scy := anyStr(j["scy"])
		if scy == "" {
			scy = "auto"
		}
		add := anyStr(j["add"])
		ob := obj{"type": "vmess", "server": add, "server_port": port, "uuid": anyStr(j["id"]), "security": scy, "alter_id": aid}
		name := anyStr(j["ps"])
		if name == "" {
			name = add
		}
		ob, err = addTLSTransport(ob, q, add, false)
		return ob, name, err
	}

	if scheme == "ss" && !strings.Contains(strings.SplitN(raw, "#", 2)[0], "@") {
		// ss://base64(method:pass@host:port)#name
		body, frag, _ := strings.Cut(raw[5:], "#")
		dec, err := b64Decode(strings.SplitN(body, "?", 2)[0])
		if err != nil {
			return nil, "", errors.New("ss: некорректный base64")
		}
		at := strings.LastIndex(dec, "@")
		if at < 0 {
			return nil, "", errors.New("ss: некорректная ссылка")
		}
		cred, hp := dec[:at], dec[at+1:]
		c, hc := strings.Index(cred, ":"), strings.LastIndex(hp, ":")
		if c < 0 || hc < 0 {
			return nil, "", errors.New("ss: некорректная ссылка")
		}
		port, _ := strconv.Atoi(hp[hc+1:])
		name := hp
		if frag != "" {
			name = unesc(frag)
		}
		return obj{"type": "shadowsocks", "server": hp[:hc], "server_port": port, "method": cred[:c], "password": cred[c+1:]}, name, nil
	}

	u, err := splitLink(raw, scheme == "ss")
	if err != nil {
		return nil, "", err
	}
	q, srv, port := u.query, u.server, u.port
	if srv == "" {
		return nil, "", errors.New("в ссылке нет адреса сервера")
	}

	switch scheme {
	case "vless":
		ob := obj{"type": "vless", "server": srv, "server_port": port, "uuid": u.user}
		if f := qget(q, "flow"); f != "" {
			ob["flow"] = f
		}
		ob, err = addTLSTransport(ob, q, srv, false)
		return ob, u.name, err
	case "trojan":
		ob := obj{"type": "trojan", "server": srv, "server_port": port, "password": unesc(u.rawUser)}
		ob, err = addTLSTransport(ob, q, srv, true)
		return ob, u.name, err
	case "ss":
		var mp string
		if !u.hasPass {
			if mp, err = b64Decode(unesc(u.rawUser)); err != nil {
				return nil, "", errors.New("ss: некорректные учётные данные")
			}
		} else {
			mp = u.user + ":" + u.pass // SIP002 / SS-2022
		}
		c := strings.Index(mp, ":")
		if c < 0 {
			return nil, "", errors.New("ss: некорректные учётные данные")
		}
		return obj{"type": "shadowsocks", "server": srv, "server_port": port, "method": mp[:c], "password": mp[c+1:]}, u.name, nil
	case "hysteria2", "hy2":
		if port == 0 {
			port = 443
		}
		ob := obj{"type": "hysteria2", "server": srv, "server_port": port, "password": unesc(u.rawUser), "tls": newTLS(q, srv, true)}
		if o := qget(q, "obfs"); o != "" {
			ob["obfs"] = obj{"type": o, "password": qget(q, "obfs-password")}
		}
		return ob, u.name, nil
	case "hysteria":
		q2 := copyMap(q)
		if qget(q2, "alpn") == "" {
			q2["alpn"] = "hysteria"
		}
		up, _ := strconv.Atoi(qget(q, "upmbps", "50"))
		down, _ := strconv.Atoi(qget(q, "downmbps", "100"))
		ob := obj{"type": "hysteria", "server": srv, "server_port": port, "up_mbps": up, "down_mbps": down, "tls": newTLS(q2, srv, true)}
		if a := qget(q, "auth"); a != "" {
			ob["auth_str"] = a
		}
		if o := qget(q, "obfsParam"); o != "" {
			ob["obfs"] = o
		}
		return ob, u.name, nil
	case "tuic":
		q2 := copyMap(q)
		if v := qget(q, "allow_insecure"); v != "" {
			q2["insecure"] = v
		}
		ob := obj{"type": "tuic", "server": srv, "server_port": port, "uuid": u.user, "password": u.pass,
			"congestion_control": qget(q, "congestion_control", "bbr"), "udp_relay_mode": qget(q, "udp_relay_mode", "native"),
			"tls": newTLS(q2, srv, true)}
		return ob, u.name, nil
	case "anytls":
		return obj{"type": "anytls", "server": srv, "server_port": port, "password": unesc(u.rawUser), "tls": newTLS(q, srv, true)}, u.name, nil
	case "socks", "socks5":
		ob := obj{"type": "socks", "server": srv, "server_port": port, "version": "5"}
		if u.user != "" {
			ob["username"], ob["password"] = u.user, u.pass
		}
		return ob, u.name, nil
	}
	return nil, "", fmt.Errorf("протокол %s не поддерживается", scheme)
}

func copyMap(m map[string]string) map[string]string {
	c := make(map[string]string, len(m)+1)
	for k, v := range m {
		c[k] = v
	}
	return c
}

func isSupportedLink(line string) bool {
	i := strings.Index(line, "://")
	if i <= 0 {
		return false
	}
	s := strings.ToLower(line[:i])
	for _, x := range schemes {
		if x == s {
			return true
		}
	}
	return false
}
