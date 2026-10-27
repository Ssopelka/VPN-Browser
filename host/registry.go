package main

import (
	"context"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter/certificate"
	"github.com/sagernet/sing-box/adapter/endpoint"
	"github.com/sagernet/sing-box/adapter/inbound"
	"github.com/sagernet/sing-box/adapter/outbound"
	"github.com/sagernet/sing-box/adapter/service"
	"github.com/sagernet/sing-box/dns"
	"github.com/sagernet/sing-box/dns/transport/local"
	"github.com/sagernet/sing-box/protocol/anytls"
	"github.com/sagernet/sing-box/protocol/direct"
	"github.com/sagernet/sing-box/protocol/hysteria"
	"github.com/sagernet/sing-box/protocol/hysteria2"
	"github.com/sagernet/sing-box/protocol/mixed"
	"github.com/sagernet/sing-box/protocol/shadowsocks"
	"github.com/sagernet/sing-box/protocol/socks"
	"github.com/sagernet/sing-box/protocol/trojan"
	"github.com/sagernet/sing-box/protocol/tuic"
	"github.com/sagernet/sing-box/protocol/vless"
	"github.com/sagernet/sing-box/protocol/vmess"
)

// Урезанный реестр: только клиентские протоколы, которые поддерживает расширение, и локальный mixed-inbound.
// Никаких tun/api/tailscale/ssh/tor — меньше размер и поверхность атаки.
func boxContext(ctx context.Context) context.Context {
	in := inbound.NewRegistry()
	mixed.RegisterInbound(in)
	socks.RegisterInbound(in)
	shadowsocks.RegisterInbound(in) // нужен тестам; в рабочем конфиге не используется
	vless.RegisterInbound(in)
	vmess.RegisterInbound(in)
	trojan.RegisterInbound(in)

	out := outbound.NewRegistry()
	direct.RegisterOutbound(out)
	socks.RegisterOutbound(out)
	shadowsocks.RegisterOutbound(out)
	vmess.RegisterOutbound(out)
	trojan.RegisterOutbound(out)
	vless.RegisterOutbound(out)
	anytls.RegisterOutbound(out)
	hysteria.RegisterOutbound(out)
	hysteria2.RegisterOutbound(out)
	tuic.RegisterOutbound(out)

	dnsReg := dns.NewTransportRegistry()
	local.RegisterTransport(dnsReg)

	return box.Context(ctx, in, out, endpoint.NewRegistry(), dnsReg, service.NewRegistry(), certificate.NewRegistry())
}
