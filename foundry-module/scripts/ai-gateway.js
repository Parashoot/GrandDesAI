import { GROWTH_TAXONOMY } from "./growth-taxonomy.js";

export function createAiGatewayAdapter({ endpoint, getHeaders = () => ({}) }) {
  assertSafeEndpoint(endpoint);
  if (typeof getHeaders !== "function") {
    throw new Error("getHeaders must be a function.");
  }
  return async ({ actor, notes }) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getHeaders() },
      body: JSON.stringify(buildAiGatewayRequest(actor, notes))
    });
    if (!response.ok) throw new Error(`AI gateway returned HTTP ${response.status}.`);
    return response.json();
  };
}

export function createChatCompletionsAdapter({ endpoint, model, getHeaders = () => ({}), requestOptions = {} }) {
  assertSafeEndpoint(endpoint);
  if (typeof model !== "string" || !model.trim()) throw new Error("An AI model name is required.");
  if (typeof getHeaders !== "function") throw new Error("getHeaders must be a function.");
  return async ({ actor, notes }) => {
    const request = buildAiGatewayRequest(actor, notes);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getHeaders() },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Return only valid JSON matching the requested events and proposals schema. Do not grant anything." },
          { role: "user", content: JSON.stringify(request) }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        ...requestOptions
      })
    });
    if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}.`);
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content ?? payload?.message?.content;
    if (typeof content !== "string") throw new Error("AI provider did not return a JSON chat-completion message.");
    try {
      return JSON.parse(content);
    } catch {
      throw new Error("AI provider returned malformed JSON.");
    }
  };
}

export function buildAiGatewayRequest(actor, notes) {
  return {
    task: "grand-design-pf2e-proposals",
    notes,
    actor: {
      name: actor.name,
      level: actor.system?.details?.level?.value ?? null,
      existingGrandDesign: actor.getFlag("grand-design-ai", "registry") ?? {}
    },
    allowedTags: GROWTH_TAXONOMY.map(([tag]) => tag),
    requirements: {
      approvalRequired: true,
      outputMustBeJson: true,
      eventSchema: {
        summary: "string",
        tags: ["string"],
        outcome: "success | criticalSuccess"
      },
      proposalSchema: {
        kind: "skill | class",
        entry: {
          name: "string",
          tier: "1 | 2 | 3 for skills",
          gameItem: { kind: "feat | action | reaction | free | passive | spell | weapon" },
          mechanics: {
            effect: "concrete game benefit",
            duration: "string",
            frequency: { max: "integer >= 1", per: "round | minute | hour | day | encounter | unlimited" },
            roll: { kind: "required for action-like entries", formula: "dice formula such as 1d20+8" }
          },
          metadata: { tags: ["string"], lineage: { operation: "origin", sources: [], rationale: "string" } }
        }
      }
    }
  };
}

function assertSafeEndpoint(endpoint) {
  if (typeof endpoint !== "string") throw new Error("The AI gateway endpoint must be a URL.");
  const url = new URL(endpoint);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("AI endpoints must use HTTPS, except a local localhost or loopback server.");
  }
}
