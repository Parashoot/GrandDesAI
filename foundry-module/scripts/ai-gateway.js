import { GROWTH_TAXONOMY } from "./growth-taxonomy.js";

export function createAiGatewayAdapter({ endpoint, getHeaders = () => ({}) }) {
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    throw new Error("The AI gateway endpoint must use HTTPS.");
  }
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
