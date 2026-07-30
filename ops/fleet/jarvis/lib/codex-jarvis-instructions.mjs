import { createHash } from "node:crypto";

const SOURCE_HEADER = "# 🟢 BOOT ORKIESTRATORA (Paperclip / VPS)";
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const MODEL_DELEGATION_BLOCK_RE =
  /## Model Delegation \(dla API pipeline'ów\)\n[\s\S]*?\n## Produktywność\n/;

const PROVIDER_NEUTRAL_MODEL_SECTION = `## Pasy zadań (neutralne względem dostawcy)

- Role przypisane do profili korzystają z pasów \`openai-first\` oraz \`anthropic-first\`, wybieranych przez fleet profile-switch.
- Domyślnym wykonawcą kodu w kokpicie pozostaje Cursor, a pozostałe adaptery działają jako pasy zapasowe zgodnie z polityką profilu.
- Dla prac ograniczonych i mechanicznych wybieraj najtańszy pas spełniający wymagania; orkiestracja, bezpieczeństwo i końcowy osąd pozostają po stronie Jarvisa.

## Produktywność
`;

function toLf(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stripFrontmatter(markdown) {
  return markdown.replace(FRONTMATTER_RE, "");
}

function translateHarnessToCodex(markdown) {
  let out = markdown;
  out = out.replace(/\bCLAUDE\.md\b/g, "AGENTS.md");
  out = out.replace(/\.claude\/rules/g, ".Codex/jarvis-rules");
  out = out.replace(/\bWrite\/Edit\b/g, "apply_patch");
  out = out.replace(/\bWrite tool\b/g, "apply_patch");
  out = out.replace(/\bEdit tool\b/g, "apply_patch");
  out = out.replace(/Skill\([^)]*\)/g, "/skill");
  return out;
}

function neutralizeVendorDelegation(markdown) {
  let out = markdown;
  out = out.replace(
    /Claude — osobisty asystent Grzegorza Golasia\./g,
    "Jarvis — osobisty asystent Grzegorza Golasia.",
  );
  out = out.replace(/\*\*Workery\*\*/g, "**Wykonawcy**");
  out = out.replace(/\btani Claude Code\b/g, "lekki wykonawca profilowy");
  out = out.replace(/\bcheap model\b/g, "najtańszy zgodny tor wykonania");
  out = out.replace(
    /Workery \(tani Claude Code, cheap model\)/g,
    "Wykonawcy (pas profilowy, najtańszy zgodny tor wykonania)",
  );
  out = out.replace(MODEL_DELEGATION_BLOCK_RE, PROVIDER_NEUTRAL_MODEL_SECTION);
  return out;
}

function replaceCockpitClaudeRefs(cockpitBody) {
  const replaced = cockpitBody.replace(/\bCLAUDE\.md\b/g, "rdzeń powyżej (sekcja Headless Core)");
  return replaced;
}

function ensureSourceShape(headless) {
  if (!headless.includes(SOURCE_HEADER)) {
    throw new Error(`headless source missing required marker: ${SOURCE_HEADER}`);
  }
}

function ensureNoForbiddenReferences(artifact) {
  if (artifact.includes("CLAUDE.md")) {
    throw new Error("generated artifact still references CLAUDE.md");
  }
  if (/\/home\/|\/Users\//.test(artifact)) {
    throw new Error("generated artifact contains forbidden absolute host paths");
  }
}

export function generateCodexJarvisInstructions({
  headlessBossClaude,
  cockpitAgentsMd,
}) {
  const sourceRaw = toLf(headlessBossClaude).replace(/^\uFEFF/, "");
  const cockpitRaw = toLf(cockpitAgentsMd).replace(/^\uFEFF/, "");
  ensureSourceShape(sourceRaw);

  const sourceSha256 = sha256(sourceRaw);
  const cockpitSha256 = sha256(cockpitRaw);

  const translatedSource = neutralizeVendorDelegation(translateHarnessToCodex(sourceRaw)).trimEnd();
  const cockpitBody = stripFrontmatter(cockpitRaw).trimStart();
  const translatedCockpit = replaceCockpitClaudeRefs(translateHarnessToCodex(cockpitBody)).trimEnd();

  const content = [
    "# AGENTS-CODEX.md",
    "",
    "Deterministic artifact generated from the read-only headless boss source and Jarvis cockpit overlay.",
    "",
    `Source SHA256: \`${sourceSha256}\``,
    `Cockpit SHA256: \`${cockpitSha256}\``,
    "",
    "## Headless Core",
    translatedSource,
    "",
    "## Cockpit Overlay",
    translatedCockpit,
    "",
  ].join("\n");

  ensureNoForbiddenReferences(content);

  return {
    content,
    sourceSha256,
    cockpitSha256,
  };
}