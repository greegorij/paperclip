import { createHash } from "node:crypto";

const SOURCE_HEADER = "# 🟢 BOOT ORKIESTRATORA (Paperclip / VPS)";
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const MODEL_DELEGATION_BLOCK_RE =
  /## Model Delegation \(dla API pipeline'ów\)\n[\s\S]*?\n## Produktywność\n/;

const BOOT_MANIFEST_LOGICAL_PATH = "01 - Jarvis/Jarvis — Boot Manifest.md";

const PROVIDER_NEUTRAL_MODEL_SECTION = `## Pasy zadań (neutralne względem dostawcy)

- Role przypisane do profili korzystają z pasów \`openai-first\` oraz \`anthropic-first\`, wybieranych przez fleet profile-switch.
- Domyślnym wykonawcą kodu w kokpicie pozostaje Cursor, a pozostałe adaptery działają jako pasy zapasowe zgodnie z polityką profilu.
- Dla prac ograniczonych i mechanicznych wybieraj najtańszy pas spełniający wymagania; orkiestracja, bezpieczeństwo i końcowy osąd pozostają po stronie Jarvisa.

## Produktywność
`;

const CODEX_VAULT_SECTION = `## 🔴 VAULT — ODCZYT PRZEZ MCP (KRYTYCZNE — profil Codex read-only)

W read-only Codex boss profile vault **nie jest zamontowany** jako filesystem. Bezpośredni dostęp do \`JARVIS_VAULT_ROOT\` oraz bezpośrednie zapisy do vaultu są niedostępne.

0. **Boot / odczyt** — używaj Paperclip-managed MCP tool \`vault_read\` (oraz \`vault_search\` / \`rag_search\` zgodnie z hierarchią). Boot Manifest: logiczna ścieżka vaultu \`${BOOT_MANIFEST_LOGICAL_PATH}\`.
1. **Trwałe mutacje vaultu** — NIE używaj \`apply_patch\` ani innych narzędzi do bezpośredniego zapisu vaultu. Deleguj do wyznaczonego agenta vaultu (PION VAULTU / Kurator Vaultu) albo jawnie zablokuj/eskaluj do GG.
2. **MCP vault — TYLKO odczyt** w tym profilu.
3. **Propagacja zmian** — przez delegację do agenta vaultu / workflow wykonawcy, nie przez lokalny mount filesystemu.

## Vault — struktura

Mapa folderów 00-99 + nawigacja → [[VAULT-INDEX]] (\`01 - Jarvis/\`, czytaj zamiast wielu search'ów) przez MCP (\`vault_read\` / \`vault_search\`). Bez bezpośredniego filesystemu vaultu.
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

/**
 * Rewrite Claude/Mac vault filesystem + write instructions into Codex read-only
 * MCP-first guidance. Vault is intentionally not mounted in this profile.
 */
function adaptCodexVaultAccess(markdown) {
  let out = markdown;

  out = out.replace(
    /1\.\s*Przeczytaj \*\*Boot Manifest\*\*: `\$\{JARVIS_VAULT_ROOT\}\/01 - Jarvis\/Jarvis — Boot Manifest\.md`[^\n]*/,
    `1. Przeczytaj **Boot Manifest** przez Paperclip-managed MCP tool \`vault_read\` używając logicznej ścieżki vaultu \`${BOOT_MANIFEST_LOGICAL_PATH}\` — aktywne projekty, mini-focus, bieżący stan. Bezpośredni dostęp do filesystemu vaultu jest niedostępny w read-only Codex boss profile.`,
  );

  out = out.replace(
    /- Stan \*\*TRWAŁY\*\* zapisuj do Boot Manifestu \/ ISA projektów w vaulcie \(nie do RAM\)\./g,
    "- Stan **TRWAŁY** w vaulcie (Boot Manifest / ISA) wymaga delegacji do wyznaczonego agenta vaultu albo jawnej blokady/eskalacji — bezpośredni zapis vaultu jest niedostępny w tym profilu Codex.",
  );

  out = out.replace(
    /## 🔴 VAULT — JAK PISAĆ \(KRYTYCZNE\)\n[\s\S]*?\n## 🔴 Session Boundary/m,
    `${CODEX_VAULT_SECTION}\n## 🔴 Session Boundary`,
  );

  out = out.replace(
    /Stan TRWAŁY zapisuj do \*\*Boot Manifestu\*\* \(kompaktowy stan\) \/ \*\*ISA projektów\*\*;/g,
    "Stan TRWAŁY w **Boot Manifestcie** / **ISA projektów** deleguj do agenta vaultu (bez bezpośredniego zapisu);",
  );

  // Any remaining direct vault filesystem path concatenations are unsafe in this profile.
  out = out.replace(/\$\{JARVIS_VAULT_ROOT\}\//g, "vault logical path ");

  return out;
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

function ensureCodexVaultConstraints(artifact) {
  if (!artifact.includes("vault_read")) {
    throw new Error("generated artifact missing vault_read boot guidance");
  }
  if (!artifact.includes(BOOT_MANIFEST_LOGICAL_PATH)) {
    throw new Error(
      `generated artifact missing Boot Manifest logical vault path: ${BOOT_MANIFEST_LOGICAL_PATH}`,
    );
  }
  if (/\$\{JARVIS_VAULT_ROOT\}\//.test(artifact)) {
    throw new Error(
      "generated artifact still claims direct JARVIS_VAULT_ROOT filesystem paths",
    );
  }
  if (
    /Zapis — ZAWSZE apply_patch/.test(artifact) ||
    /apply_patch tool.*JARVIS_VAULT_ROOT/.test(artifact) ||
    /do ścieżki lokalnej pod `JARVIS_VAULT_ROOT`/.test(artifact)
  ) {
    throw new Error(
      "generated artifact still claims direct vault writes via apply_patch / local path",
    );
  }
  if (
    /Przeczytaj \*\*Boot Manifest\*\*: `\$\{JARVIS_VAULT_ROOT\}/.test(artifact) ||
    /Przeczytaj \*\*Boot Manifest\*\*: `[^`]*Jarvis — Boot Manifest\.md`/.test(artifact)
  ) {
    throw new Error(
      "generated artifact still claims direct filesystem Boot Manifest open",
    );
  }
  if (!/deleguj do wyznaczonego agenta vaultu|PION VAULTU|Kurator Vaultu/.test(artifact)) {
    throw new Error(
      "generated artifact missing vault mutation delegation / escalation guidance",
    );
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

  const translatedSource = adaptCodexVaultAccess(
    neutralizeVendorDelegation(translateHarnessToCodex(sourceRaw)),
  ).trimEnd();
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
  ensureCodexVaultConstraints(content);

  return {
    content,
    sourceSha256,
    cockpitSha256,
  };
}
