// Board 2d795cac: plain http:// to a machine on the GM's LAN (a home Ollama box, jev-proxy on another
// PC) is refused unless the GM ticks "Allow plain HTTP to my local network". Public http is refused
// always; https and loopback are unchanged. The form (validateEndpointUrl) and the transport guard
// (assertSafeEndpoint) must agree on every address.
import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeEndpoint, createTransport, endpointSafetyProblem, isPrivateNetworkHost } from "../scripts/ai/transport.js";
import { GATEWAY_DEFAULTS, normalizeGatewayConfig } from "../scripts/ai/gateway-config.js";
import { createGatewayAdapter } from "../scripts/ai-gateway.js";
import {
  ALLOW_PRIVATE_HTTP_SETTING,
  buildGatewayConfig,
  defaultGatewaySettings,
  ENDPOINT_HELP,
  formDataToSettings,
  renderGatewayForm,
  settingsWrites,
  testJevConnection,
  validateEndpointUrl
} from "../scripts/ai-provider-config.js";

const PRIVATE = [
  "http://10.0.0.5:11434",
  "http://10.255.255.255:11434",
  "http://172.16.0.1:11434",
  "http://172.31.255.254:11434",
  "http://192.168.1.50:11434",
  "http://169.254.10.20:11434",
  "http://[fd12:3456:789a::1]:11434",
  "http://[fc00::1]:11434",
  "http://[fe80::1]:11434",
  "http://[febf::1]:11434",
  "http://[::ffff:192.168.1.5]:11434",
  "http://ollama-box.local:11434",
  "http://gpu.home.lan:11434"
];
const PUBLIC = [
  "http://8.8.8.8",
  "http://172.15.0.1:11434",
  "http://172.32.0.1:11434",
  "http://192.169.1.1:11434",
  "http://11.0.0.1:11434",
  "http://169.255.0.1:11434",
  "http://[2001:4860:4860::8888]:11434",
  "http://[fec0::1]:11434",
  "http://[::ffff:8.8.8.8]:11434",
  "http://example.com:11434",
  "http://local.example.com:11434",
  "http://lan.evil.com:11434",
  "http://0.0.0.0:11434"
];
const ALWAYS_OK = ["https://api.openai.com/v1", "https://192.168.1.50:11434", "https://api.typesafe.ai", "http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"];

test("isPrivateNetworkHost: the listed ranges, nothing else", () => {
  for (const url of PRIVATE) assert.equal(isPrivateNetworkHost(new URL(url).hostname), true, url);
  for (const url of PUBLIC) assert.equal(isPrivateNetworkHost(new URL(url).hostname), false, url);
  assert.equal(isPrivateNetworkHost("127.0.0.1"), false, "loopback is its own (always-allowed) case");
});

test("each private range is allowed only with the opt-in, in the transport AND the form", () => {
  for (const url of PRIVATE) {
    assert.throws(() => assertSafeEndpoint(url), /Allow plain HTTP to my local network/, url);
    assert.throws(() => assertSafeEndpoint(url, { allowPrivateHttp: false }), /local network/, url);
    assert.doesNotThrow(() => assertSafeEndpoint(url, { allowPrivateHttp: true }), url);
    assert.match(validateEndpointUrl(url), /Tick "Allow plain HTTP to my local network"/, url);
    assert.equal(validateEndpointUrl(url, { allowPrivateHttp: true }), null, url);
  }
});

test("public plain http is always rejected, opt-in or not; https and loopback unchanged", () => {
  for (const url of PUBLIC) {
    for (const allowPrivateHttp of [false, true]) {
      assert.throws(() => assertSafeEndpoint(url, { allowPrivateHttp }), /must use HTTPS/, `${url} ${allowPrivateHttp}`);
      assert.match(validateEndpointUrl(url, { allowPrivateHttp }), /^Remote AI endpoints must use HTTPS/, url);
    }
  }
  for (const url of ALWAYS_OK) {
    for (const allowPrivateHttp of [false, true]) {
      assert.doesNotThrow(() => assertSafeEndpoint(url, { allowPrivateHttp }), url);
      assert.equal(validateEndpointUrl(url, { allowPrivateHttp }), null, url);
    }
  }
  for (const bad of ["ftp://192.168.1.5", "file:///etc/passwd"]) assert.ok(validateEndpointUrl(bad, { allowPrivateHttp: true }), bad);
});

test("transport and form agree on every address", () => {
  for (const url of [...PRIVATE, ...PUBLIC, ...ALWAYS_OK, "ftp://localhost", "not a url"]) {
    for (const allowPrivateHttp of [false, true]) {
      let threw = false;
      try { assertSafeEndpoint(url, { allowPrivateHttp }); } catch { threw = true; }
      assert.equal(threw, validateEndpointUrl(url, { allowPrivateHttp }) !== null, `${url} ${allowPrivateHttp}`);
      assert.equal(Boolean(endpointSafetyProblem(url, { allowPrivateHttp })), threw, url);
    }
  }
});

test("gateway-config: allowPrivateHttp defaults off and only literal true turns it on", () => {
  assert.equal(GATEWAY_DEFAULTS.allowPrivateHttp, false);
  assert.equal(normalizeGatewayConfig({}).allowPrivateHttp, false);
  for (const noise of ["true", "on", 1, "yes", {}, null]) assert.equal(normalizeGatewayConfig({ allowPrivateHttp: noise }).allowPrivateHttp, false, String(noise));
  assert.equal(normalizeGatewayConfig({ allowPrivateHttp: true }).allowPrivateHttp, true);
});

test("createTransport and createGatewayAdapter honour the flag from config", () => {
  const lan = "http://192.168.1.50:11434";
  assert.throws(() => createTransport({ provider: "ollama", endpoint: lan, model: "m" }), /local network/);
  assert.doesNotThrow(() => createTransport({ provider: "ollama", endpoint: lan, model: "m", allowPrivateHttp: true }));
  assert.throws(() => createTransport({ provider: "ollama", endpoint: "http://8.8.8.8", model: "m", allowPrivateHttp: true }), /HTTPS/);
  assert.throws(() => createGatewayAdapter({ endpoint: lan, model: "m" }), /local network/);
  let seen = null;
  const adapter = createGatewayAdapter({ endpoint: lan, model: "m", allowPrivateHttp: true }, {
    transportFactory: (opts) => { seen = opts; return createTransport(opts); }
  });
  assert.ok(adapter);
  assert.equal(seen.allowPrivateHttp, true, "the flag reaches the transport's own guard");
});

test("form: the box round-trips through formData, settings writes and buildGatewayConfig", () => {
  const base = { provider: "ollama", endpoint: "http://192.168.1.50:11434", model: "qwen3.8:27b" };
  const off = formDataToSettings(base);
  assert.equal(off.basics.allowPrivateHttp, false);
  assert.ok(off.errors.some((error) => /Allow plain HTTP to my local network/.test(error)), "Save is blocked with the option named");
  const on = formDataToSettings({ ...base, allowPrivateHttp: "on" });
  assert.deepEqual(on.errors, []);
  const writes = new Map(settingsWrites(on, { isGM: true }));
  assert.equal(writes.get(ALLOW_PRIVATE_HTTP_SETTING), true);
  assert.equal(new Map(settingsWrites(off)).get(ALLOW_PRIVATE_HTTP_SETTING), false);
  const config = buildGatewayConfig(on);
  assert.equal(config.allowPrivateHttp, true);
  assert.equal(buildGatewayConfig({ basics: { provider: "ollama" } }).allowPrivateHttp, false);
  assert.equal(defaultGatewaySettings("ollama").basics.allowPrivateHttp, false);
  // Public http stays blocked even with the box ticked.
  const pub = formDataToSettings({ ...base, endpoint: "http://8.8.8.8:11434", allowPrivateHttp: "on" });
  assert.ok(pub.errors.some((error) => /must use HTTPS/.test(error)));
});

test("the Jev endpoint follows the same rule (Save and Test Jev)", async () => {
  const jevForm = { provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "m", jevEnabled: "on", jevApiKey: "k", jevEndpoint: "http://192.168.1.60:8788" };
  const off = formDataToSettings(jevForm);
  assert.ok(off.errors.some((error) => /^Jev endpoint: .*Allow plain HTTP to my local network/.test(error)), off.errors.join(" | "));
  assert.deepEqual(formDataToSettings({ ...jevForm, allowPrivateHttp: "on" }).errors, []);
  assert.ok(formDataToSettings({ ...jevForm, jevEndpoint: "http://8.8.8.8:8788", allowPrivateHttp: "on" }).errors.some((error) => /^Jev endpoint: Remote AI endpoints must use HTTPS/.test(error)));

  const jev = { apiKey: "k", endpoint: "http://192.168.1.60:8788" };
  const loadJev = async () => ({ createJevClient: () => ({ ping: async () => ({ ok: true, ms: 3, models: ["jev-latest"] }) }) });
  const refused = await testJevConnection(jev, { loadJev });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /^Jev endpoint: .*Allow plain HTTP to my local network/);
  const allowed = await testJevConnection(jev, { loadJev, allowPrivateHttp: true });
  assert.equal(allowed.ok, true);
  const publicHttp = await testJevConnection({ apiKey: "k", endpoint: "http://8.8.8.8:8788" }, { loadJev, allowPrivateHttp: true });
  assert.equal(publicHttp.ok, false);
});

test("form HTML: the box, its state, and the help on where calls come from", () => {
  const offHtml = renderGatewayForm(buildGatewayConfig({ basics: { provider: "ollama" } }), {});
  assert.match(offHtml, /<input type="checkbox" name="allowPrivateHttp" >/);
  const onHtml = renderGatewayForm(buildGatewayConfig({ basics: { provider: "ollama", allowPrivateHttp: true } }), {});
  assert.match(onHtml, /name="allowPrivateHttp" checked/);
  assert.match(ENDPOINT_HELP, /this browser, not from the Foundry server/);
  assert.match(ENDPOINT_HELP, /OLLAMA_HOST=0\.0\.0\.0/);
  assert.match(ENDPOINT_HELP, /OLLAMA_ORIGINS/);
  assert.match(offHtml, /127\.0\.0\.1 means the PC you are using right now/);
  const jevHtml = renderGatewayForm(buildGatewayConfig({ basics: { provider: "ollama", jevApiKey: "k" }, client: { jev: { enabled: true } } }), {});
  assert.match(jevHtml, /jev-proxy\.mjs/);
  assert.match(jevHtml, /--host 0\.0\.0\.0/);
});

test("Foundry wiring: the setting is registered like provider/endpoint (Boolean, default off) and read into the config", async () => {
  const { registerAiProviderSettings, getGatewayConfig, providerSettingScope } = await import("../scripts/ai-provider-config.js");
  const saved = { game: globalThis.game, FormApplication: globalThis.FormApplication };
  const store = new Map();
  const registered = [];
  globalThis.FormApplication = class {};
  globalThis.game = {
    release: { generation: 14 },
    user: { isGM: true },
    settings: {
      register: (mod, key, options) => registered.push({ key, options }),
      registerMenu() {},
      get: (mod, key) => {
        const entry = registered.find((item) => item.key === key);
        if (!entry) throw new Error(`${key} is not registered`);
        return store.has(key) ? store.get(key) : entry.options.default;
      }
    }
  };
  try {
    registerAiProviderSettings();
    const entry = registered.find((item) => item.key === ALLOW_PRIVATE_HTTP_SETTING);
    assert.ok(entry);
    assert.equal(entry.options.type, Boolean);
    assert.equal(entry.options.default, false);
    assert.equal(entry.options.scope, providerSettingScope(14));
    assert.equal(entry.options.scope, registered.find((item) => item.key === "aiEndpoint").options.scope);
    store.set("aiProvider", "ollama");
    store.set("aiEndpoint", "http://192.168.1.50:11434");
    assert.equal(getGatewayConfig().allowPrivateHttp, false);
    store.set(ALLOW_PRIVATE_HTTP_SETTING, true);
    const config = getGatewayConfig();
    assert.equal(config.allowPrivateHttp, true);
    assert.equal(config.endpoint, "http://192.168.1.50:11434");
    assert.ok(createGatewayAdapter(config));
  } finally {
    Object.assign(globalThis, saved);
  }
});
