#!/usr/bin/env node
// Live Jev check from the real Foundry origin (the only place CORS applies): joins as Gamemaster,
// runs the Gateway form's Test Jev path straight at api.typesafe.ai (expected: blocked by CORS, with
// an actionable message) and through tools/jev-proxy.mjs (expected: models listed). Changes nothing
// in the world. Key from TYPESAFE_API_KEY; it is passed to the page only for this test call.
//   node tools/playtest/live-jev.mjs [--url http://localhost:30000] [--port 8788]
import { chromium } from "playwright";
import { createJevProxy } from "../jev-proxy.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => (arg.startsWith("--") ? [...acc, [arg.slice(2), all[i + 1]]] : acc), []));
const URL = args.url || "http://localhost:30000";
const PORT = Number(args.port || 8788);
const MOD = "grand-design-ai";
const apiKey = String(process.env.TYPESAFE_API_KEY || "").trim();
if (!apiKey) { console.error("Set TYPESAFE_API_KEY."); process.exit(1); }

const proxy = createJevProxy({});
await new Promise((resolve) => proxy.listen(PORT, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: !process.env.FOUNDRY_HEADFUL });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
try {
  const page = await browser.newPage();
  await page.goto(`${URL}/join`, { waitUntil: "domcontentloaded" });
  await page.fill("#join-username", "Gamemaster");
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/join"), { timeout: 20000 }).catch(() => {}), page.click('button[name="join"]')]);
  await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 60000 });

  const out = await page.evaluate(async ({ mod, apiKey, port }) => {
    const base = `/modules/${mod}/scripts`;
    const cfg = await import(`${base}/ai-provider-config.js`);
    const direct = await cfg.testJevConnection({ apiKey, endpoint: "https://api.typesafe.ai" });
    const viaProxy = await cfg.testJevConnection({ apiKey, endpoint: `http://127.0.0.1:${port}` });
    const html = cfg.renderJevFieldset({ enabled: true, apiKey: "x", endpoint: `http://127.0.0.1:${port}` });
    return {
      system: game.system.id,
      build: game.modules.get(mod)?.version,
      direct, directMessage: direct.ok ? "" : cfg.describeJevError(direct),
      viaProxy,
      fieldset: /data-action="test-jev"/.test(html)
    };
  }, { mod: MOD, apiKey, port: PORT });

  console.log(`world system ${out.system}, module ${out.build}`);
  check("direct call to api.typesafe.ai is blocked in the browser (CORS)", out.direct.ok === false, out.directMessage);
  check("blocked message names the proxy", /jev-proxy/.test(out.directMessage));
  check("Test Jev through jev-proxy succeeds", out.viaProxy.ok === true, out.viaProxy.ok ? `${Math.round(out.viaProxy.ms)} ms, models ${out.viaProxy.models?.join(", ")}` : out.viaProxy.error);
  check("Jev fieldset renders Test Jev", out.fieldset);
} finally {
  await browser.close();
  proxy.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
