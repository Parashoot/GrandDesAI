import test from "node:test";
import assert from "node:assert/strict";
import { createJevProxy, parseArgs } from "../tools/jev-proxy.mjs";

async function withProxy(options, fn) {
  const server = createJevProxy(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("jev-proxy answers the browser preflight that api.typesafe.ai refuses", async () => {
  await withProxy({ fetchImpl: async () => { throw new Error("no upstream call on preflight"); } }, async (base) => {
    const res = await fetch(`${base}/v1/systemone`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:30000", "Access-Control-Request-Method": "POST" }
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:30000");
    assert.match(res.headers.get("access-control-allow-headers"), /authorization/);
  });
});

test("jev-proxy forwards the browser's own key and body, never one of its own", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ answers: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await withProxy({ upstream: "https://up.example", fetchImpl }, async (base) => {
    const res = await fetch(`${base}/v1/systemone`, {
      method: "POST",
      headers: { Origin: "http://localhost:30000", Authorization: "Bearer k1", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest" })
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:30000");
    assert.deepEqual(await res.json(), { answers: {} });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://up.example/v1/systemone");
  assert.equal(calls[0].init.headers.authorization, "Bearer k1");
  assert.equal(JSON.parse(Buffer.from(calls[0].init.body).toString()).model, "jev-latest");
});

test("jev-proxy only forwards the Jev paths, honours --origin, and turns a dead upstream into 502", async () => {
  await withProxy({ origins: ["http://localhost:30000"], fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }, async (base) => {
    assert.equal((await fetch(`${base}/v1/other`, { headers: { Origin: "http://localhost:30000" } })).status, 404);
    assert.equal((await fetch(`${base}/v1/models`, { headers: { Origin: "https://evil.example" } })).status, 403);
    const dead = await fetch(`${base}/v1/models`, { headers: { Origin: "http://localhost:30000" } });
    assert.equal(dead.status, 502);
    assert.match(await dead.text(), /ECONNREFUSED/);
  });
  assert.deepEqual(parseArgs(["--port", "9000", "--origin", "a", "--origin", "b"]).origins, ["a", "b"]);
});
