# Live AI-Provider Test Campaign

`TEST_SCENARIO.md` ("The First Steam") verifies the Grand Design workflow with hand-written
fixture data — it never calls an AI provider. This campaign is the counterpart: it makes real
calls to whatever provider is configured in **Configure Settings → Grand Design AI → Configure AI
Provider** (Ollama by default) and checks that what comes back is actually usable — schema-valid,
PF2e-legal, and capable of becoming a real Item on an Actor.

Because it depends on a live local model, its output is genuinely different every run. That's the
point: it's exercising the same request/response path a GM hits from the Growth Manager dialog,
not a scripted fixture.

## Run it in Foundry (manual, GM-only)

As GM, with an AI provider configured, run this in a Macro:

```js
const report = await game.modules.get("grand-design-ai").api.runAiTestScenario();
console.table(report.generated);
```

It creates one tagged test Actor ("GD AI Test - Kellin the Undercutter"), sends it six
session-note "beats" — each a different kind of fictional moment (improvised skill, an offensive
strike, a triggered defense, an elemental effect, a rallying free action, an ongoing instinct) —
through `analyzeSessionNotes()`, and lets the model decide what each one becomes rather than
telling it which PF2e item kind to produce. It then resolves a rest and approves one generated
proposal into a real Item, so the run proves out validation *and* the actual Item-creation path.

Clean up with:

```js
await game.modules.get("grand-design-ai").api.clearAiTestScenario();
```

This never deletes anything from "The First Steam" campaign or from real player data — it only
ever touches documents flagged `aiTestScenario`, which is a separate flag from that campaign's
`testScenario` tag. It is not wired into "Run Test Campaign on Launch" — that setting stays
scoped to the deterministic campaign, since this one makes real, possibly slow model calls.

## Run it automatically, from outside Foundry

`tests/integration/run-live-ai-campaign.mjs` drives a real browser (via Playwright) against your
running Foundry server, logs in as GM, configures the AI provider, runs the same campaign as
above, and prints every entry the model generated — kind, PF2e comparison, effect text, tags —
plus which one got approved into a real Item.

```powershell
cd foundry-module
npm install
npx playwright install chromium   # one-time browser download
npm run test:live-ai
```

Set `FOUNDRY_GM_PASSWORD` in your own shell (or a local `tests/integration/.env` you create from
`.env.example`, which is gitignored) before running it if your GM account has a password — see
that file for every supported variable. Nothing in this script hardcodes, logs, or is ever told a
password over chat; only environment variables you set yourself.

This is **not** part of `npm test` and does not run in CI. It requires a running Foundry world
and, for the default `ollama` provider, a running local Ollama server with the configured model
pulled. Run it by hand when you want to check the real end-to-end path — for fast, offline,
every-commit coverage of the request/response shaping and validation logic, see
`tests/ai-gateway.test.mjs` and `tests/ai-test-scenario.test.mjs` instead, which mock the network
call and run in well under a second.

## What "pass" means here

The report's `ok` is only `false` for real problems: no AI provider configured, a request that
errored, a response that failed PF2e/schema validation, or the campaign producing nothing at all
across all six beats. It is **not** a failure for the model to decide a given beat lacks enough
evidence and return no proposal for it (the system prompt explicitly allows that), or to lean
toward one `gameItem.kind` more than others in a given run — `report.kindsCovered` reports the
actual spread it produced so you can see model behavior over time, but a narrower spread isn't
treated as a bug in a single run of a small local model.
