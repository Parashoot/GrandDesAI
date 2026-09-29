// Build stamp. The committed copy is the "dev" default; tools/deploy-foundry-module.ps1 overwrites
// the DEPLOYED copy (never this source file) with the git short SHA, time and dirty flag so the GM
// can tell at a glance which code a running world actually loaded (board 30f2b191: a live install
// was four days stale and nothing said so).
export const BUILD = Object.freeze({ sha: "dev", builtAt: null, dirty: false });

/** "dev ..." or "abc1234 (2026-09-29 12:00, uncommitted changes)" -- pure, used in logs and settings UIs. */
export function describeBuild(build = BUILD) {
  if (!build || !build.sha || build.sha === "dev") return "dev (not deployed by the deploy script)";
  const when = build.builtAt ? String(build.builtAt).replace("T", " ").slice(0, 16) : "";
  const bits = [when, build.dirty ? "uncommitted changes" : ""].filter(Boolean);
  return `${build.sha}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}
