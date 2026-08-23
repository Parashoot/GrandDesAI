import assert from "node:assert/strict";
import test from "node:test";

import { buildAiGatewayRequest, createAiGatewayAdapter } from "../scripts/ai-gateway.js";

const actor = {
  name: "Ari",
  system: { details: { level: { value: 5 } } },
  getFlag: () => ({ skills: {} })
};

test("AI gateway request supplies bounded context and schema", () => {
  const request = buildAiGatewayRequest(actor, "Ari saved the ferry.");

  assert.equal(request.task, "grand-design-pf2e-proposals");
  assert.equal(request.actor.level, 5);
  assert.ok(request.allowedTags.includes("medicine"));
  assert.equal(request.requirements.approvalRequired, true);
});

test("AI gateway only accepts HTTPS endpoints", () => {
  assert.throws(() => createAiGatewayAdapter({ endpoint: "http://insecure.example" }));
  assert.doesNotThrow(() => createAiGatewayAdapter({ endpoint: "http://127.0.0.1:11434/v1/chat/completions" }));
});
