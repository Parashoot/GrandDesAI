#!/usr/bin/env node
// Local CORS proxy for Jev (TypeSafe).
//
// Why: api.typesafe.ai answers every browser preflight with "Disallowed CORS origin" (checked
// 2026-09-29 for localhost, 127.0.0.1, https and forge-vtt origins), and Foundry makes AI calls
// from the GM's browser, so without this proxy Jev never runs inside Foundry (the gateway fails
// open and carries on without it). Node is not a browser, so it can call the API directly.
//
// Run it on the GM's PC (the machine whose browser runs Foundry, same as Ollama):
//   node tools/jev-proxy.mjs [--port 8788] [--upstream https://api.typesafe.ai] [--origin http://localhost:30000]
// then set the Jev endpoint in the Gateway settings to http://127.0.0.1:8788 and click Test Jev.
// On another machine: add --host 0.0.0.0, point the endpoint at http://<its LAN address>:8788 and tick
// "Allow plain HTTP to my local network" (plain http is otherwise refused for non-loopback hosts).
//
// It never stores or injects a key: the browser sends its own Authorization header, so an origin
// that reaches the proxy can only spend a key it already has. Only the two Jev paths are forwarded.
// Zero dependencies (Node 18+ for global fetch).
import http from "node:http";
import { pathToFileURL } from "node:url";

const ALLOWED_PATHS = new Set(["/v1/systemone", "/v1/models"]);

export function parseArgs(argv) {
  const out = { port: 8788, host: "127.0.0.1", upstream: "https://api.typesafe.ai", origins: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--port") { out.port = Number(value); i += 1; }
    else if (flag === "--host") { out.host = String(value); i += 1; }
    else if (flag === "--upstream") { out.upstream = String(value).replace(/\/+$/, ""); i += 1; }
    else if (flag === "--origin") { out.origins.push(String(value)); i += 1; }
    else if (flag === "--help" || flag === "-h") out.help = true;
  }
  return out;
}

function corsHeaders(origin, allowed) {
  const ok = !allowed.length || (origin && allowed.includes(origin));
  if (!ok) return null;
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "7200",
    vary: "Origin"
  };
}

export function createJevProxy({ upstream = "https://api.typesafe.ai", origins = [], fetchImpl = globalThis.fetch } = {}) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = corsHeaders(origin, origins);
    if (!cors) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Origin not allowed by jev-proxy (--origin).");
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const path = new URL(req.url, "http://proxy").pathname;
    if (!ALLOWED_PATHS.has(path) || !["GET", "POST"].includes(req.method)) {
      res.writeHead(404, { ...cors, "content-type": "text/plain" });
      res.end("jev-proxy forwards only GET /v1/models and POST /v1/systemone.");
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { "content-type": req.headers["content-type"] || "application/json" };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    try {
      const upstreamRes = await fetchImpl(`${upstream}${path}`, {
        method: req.method,
        headers,
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined
      });
      const body = Buffer.from(await upstreamRes.arrayBuffer());
      const passHeaders = { ...cors, "content-type": upstreamRes.headers.get("content-type") || "application/json" };
      const retryAfter = upstreamRes.headers.get("retry-after");
      if (retryAfter) passHeaders["retry-after"] = retryAfter;
      res.writeHead(upstreamRes.status, passHeaders);
      res.end(body);
    } catch (error) {
      // 502 is retried by jev.js like any 5xx; the message says which hop failed.
      res.writeHead(502, { ...cors, "content-type": "text/plain" });
      res.end(`jev-proxy could not reach ${upstream}: ${error?.message || error}`);
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !Number.isInteger(args.port)) {
    console.log("Usage: node tools/jev-proxy.mjs [--port 8788] [--host 127.0.0.1] [--upstream https://api.typesafe.ai] [--origin http://localhost:30000 ...]");
    process.exit(args.help ? 0 : 1);
  }
  createJevProxy(args).listen(args.port, args.host, () => {
    console.log(`jev-proxy: http://${args.host}:${args.port} -> ${args.upstream}${args.origins.length ? ` (origins: ${args.origins.join(", ")})` : " (any origin; the browser supplies its own key)"}`);
    console.log(`Set the Jev endpoint in Grand Design's Gateway settings to http://${args.host === "0.0.0.0" ? "127.0.0.1" : args.host}:${args.port}`);
    // Board 2d795cac: from another PC the endpoint is this machine's LAN address, and plain HTTP to
    // it needs the Gateway's "Allow plain HTTP to my local network" box.
    if (args.host === "0.0.0.0") console.log(`From another PC on your network: http://<this machine's LAN address>:${args.port}, and tick "Allow plain HTTP to my local network" in the Gateway settings.`);
  });
}
