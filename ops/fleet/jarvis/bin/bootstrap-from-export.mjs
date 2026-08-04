#!/usr/bin/env node
/**
 * One-shot: materialize portable package from a secret-free Paperclip company export JSON.
 * Does not contact live API. Strips host paths and secret values.
 * Does NOT vendor skills/local or skills/company playbooks.
 *
 * Usage:
 *   node ops/fleet/jarvis/bin/bootstrap-from-export.mjs <export.json> [--out ops/fleet/jarvis/package]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { summarizeExportWarnings } from "../lib/sanitize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const HOST_PATH_RE = /\/home\/[^\s"'`]+|\/Users\/[^\s"'`]+/g;

const BRANCH_EDIT_BLOCK_RE =
  /## 🔴 GDZIE WOLNO PISAĆ KOD \(twarda zasada, egzekwowana bramą\)[\s\S]*?(?=\n## |\n---\n)/;

const SENIOR_REPLACEMENT = `## 🔴 TY NIE PISZESZ KODU — PLANUJESZ, DELEGUESZ, RECENZUJESZ

Nie tworzysz gałęzi, nie edytujesz plików kodu i nie zatwierdzasz zmian osobiście.
Wykonawcą kodu jest Cursor (domyślnie), szybki Codex Mini (małe dobrze opisane joby),
albo ciężki Codex / inny mięsień z Twojego pionu.
Twoja robota: brief/plan → zlecenie → odbiór → werdykt. Gałąź i zatwierdzenie
zmian to warunek odbioru **u wykonawcy**, nie Twoja osobista sesja edycji.

`;

const READONLY_REPLACEMENT = `## 🔴 TY NIE EDYTUJESZ KODU

Ta rola jest tylko do odczytu (lub wyłącznie do mechanicznego wdrożenia
zacommitowanej zmiany). Nie tworzysz gałęzi, nie edytujesz plików i nie
zatwierdzasz zmian. Werdykt / raport / deploy — bez osobistej edycji kodu.

`;

const DEPLOY_REPLACEMENT = `## 🔴 TY NIE EDYTUJESZ KODU ANI NIE PROWADZISZ GIT

Wdrażasz mechanicznie już zacommitowaną zmianę (metoda per-repo z briefu /
DEPLOYMENT.md). Nie tworzysz gałęzi, nie edytujesz plików kodu, nie zatwierdzasz
i nie wypychasz. Git poza kontrolowanym targetem Makefile monorepo jest zakazany.

`;

/** @type {Record<string, string[]>} */
const SKILL_OVERRIDES = {
  "in-ynier-wdro-e": [
    "paperclipai/paperclip/paperclip",
    "local/ticket",
    "local/contract",
  ],
  "senior-programista": [
    "paperclipai/paperclip/paperclip",
    "paperclipai/paperclip/paperclip-converting-plans-to-tasks",
    "local/coding-workflow",
    "local/review",
    "local/code-quality",
    "local/ticket",
    "local/layered-design",
    "local/grill-me",
  ],
  "mi-sie-web": ["paperclipai/paperclip/paperclip", "local/research"],
  "mi-sie-recenzji-glm": [
    "paperclipai/paperclip/paperclip",
    "local/review",
    "local/contract",
  ],
  "konfigurator-systemu": [
    "paperclipai/paperclip/paperclip",
    "local/coding-workflow",
    "local/review",
    "local/commit",
    "local/ticket",
    "local/contract",
    "local/code-quality",
    "paperclipai/optional/browser/agent-browser",
  ],
};

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function skillShortName(key) {
  const parts = String(key).split("/");
  return parts[parts.length - 1] || key;
}

function resolveLocalSkillKey(shortOrFull, catalogKeys) {
  // Exact full key wins. Short/pseudo input with 0 or >1 matches fails closed — never matches[0].
  if (catalogKeys.has(shortOrFull)) return shortOrFull;
  const short = skillShortName(shortOrFull);
  const matches = [...catalogKeys].filter((k) => skillShortName(k) === short);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    die(`Bootstrap skill key unresolved (0 matches): ${shortOrFull}`);
  }
  die(
    `Bootstrap skill key ambiguous (${matches.length} matches for short "${short}"): ${shortOrFull}`,
  );
}

function rewriteFrontmatterSkills(content, desiredKeys) {
  const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) return content;
  const body = content.slice(fm[0].length);
  let yaml = fm[1];
  const skillsBlock = desiredKeys.map((k) => `  - "${k}"`).join("\n");
  const skillsRe = /^skills:\n(?:  - .+\n)*(?:  - .+)?/m;
  if (skillsRe.test(yaml)) {
    yaml = yaml.replace(skillsRe, `skills:\n${skillsBlock}`);
  } else {
    yaml = `${yaml}\nskills:\n${skillsBlock}`;
  }
  return `---\n${yaml}\n---\n${body}`;
}

function fixInReviewSemantics(content) {
  let out = content;
  out = out.replace(
    /in_review gdy potrzebna weryfikacja przełożonego; blocked gdy utknąłeś, ze wskazaniem kto\/co odblokowuje\)\./g,
    "done gdy wynik gotowy (weryfikacja przełożonego-agenta NIE jest powodem `in_review`); `in_review` wyłącznie gdy realnie czekasz na decyzję człowieka; blocked gdy utknąłeś, ze wskazaniem kto/co odblokowuje).",
  );
  out = out.replace(
    /Status in_review po dostarczeniu\./g,
    "Status `done` po dostarczeniu (przełożony-agent odbierze w swoim przebiegu). `in_review` tylko przy realnym oczekiwaniu na człowieka.",
  );
  out = out.replace(
    /potem status in_review\. Nie naprawiasz\./g,
    "potem status `done`. Nie naprawiasz. `in_review` tylko przy realnym oczekiwaniu na człowieka.",
  );
  return out;
}

function removeBranchEditBlock(content, replacement) {
  if (!BRANCH_EDIT_BLOCK_RE.test(content)) return content;
  return content.replace(BRANCH_EDIT_BLOCK_RE, replacement);
}

/**
 * Keep env declarations; remove host-path defaults (empty default if schema needs a key).
 * Also strip any residual absolute paths from the sidecar.
 */
function sanitizePaperclipYaml(yamlText) {
  return yamlText
    .split("\n")
    .map((line) => {
      if (/^\s+default:\s+"/.test(line) && HOST_PATH_RE.test(line)) {
        return line.replace(/default:\s+".*"/, 'default: ""');
      }
      if (/^\s+command:\s+"/.test(line) && HOST_PATH_RE.test(line)) {
        return null; // omit system-dependent command bindings
      }
      if (HOST_PATH_RE.test(line)) {
        return line.replace(HOST_PATH_RE, "");
      }
      return line;
    })
    .filter((line) => line != null)
    .join("\n");
}

function shouldSkipExportPath(rel) {
  if (rel.startsWith("images/")) return true;
  if (rel.startsWith("skills/")) return true; // never vendor skill playbooks
  if (rel.includes("secret") || /\b(api[_-]?key|token|password)\b/i.test(rel)) return true;
  return false;
}

function writeText(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

function main() {
  const args = process.argv.slice(2);
  const exportPath = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outDir =
    outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(ROOT, "package");
  if (!exportPath) die("Usage: bootstrap-from-export.mjs <export.json> [--out dir]");
  if (!existsSync(exportPath)) die(`Export not found: ${exportPath}`);

  const raw = readFileSync(exportPath, "utf8");
  const data = JSON.parse(raw);
  const files = data.files ?? {};
  const manifest = data.manifest ?? {};
  const catalogKeys = new Set((manifest.skills ?? []).map((s) => s.key));

  const resolvedOverrides = {};
  for (const [slug, keys] of Object.entries(SKILL_OVERRIDES)) {
    resolvedOverrides[slug] = keys.map((k) => resolveLocalSkillKey(k, catalogKeys));
  }

  const agents = manifest.agents ?? [];
  if (agents.length !== 27) {
    console.warn(`Warning: expected 27 exportable agents, got ${agents.length}`);
  }

  // Clean previous package output (especially leftover skills/)
  if (existsSync(outDir)) {
    rmSync(path.join(outDir, "skills"), { recursive: true, force: true });
  }

  let written = 0;
  let skippedSkills = 0;
  for (const [rel, contents] of Object.entries(files)) {
    if (typeof contents !== "string") continue;
    if (rel.startsWith("skills/")) {
      skippedSkills += 1;
      continue;
    }
    if (shouldSkipExportPath(rel)) continue;

    let text = contents;
    if (rel === ".paperclip.yaml") {
      text = sanitizePaperclipYaml(text);
    }

    if (rel.startsWith("agents/") && rel.endsWith("/AGENTS.md")) {
      // Agent prompts may mention host paths in env prose — redact to a token, not a real path.
      text = text.replace(HOST_PATH_RE, "<host-path-redacted>");
      const slug = rel.split("/")[1];
      if (["recenzent", "zwiadowca-kodu"].includes(slug)) {
        text = removeBranchEditBlock(text, READONLY_REPLACEMENT);
      } else if (slug === "in-ynier-wdro-e") {
        text = removeBranchEditBlock(text, DEPLOY_REPLACEMENT);
      } else if (slug === "senior-programista") {
        text = removeBranchEditBlock(text, SENIOR_REPLACEMENT);
        text = text.replace(
          /przepis niżej \(„GDZIE WOLNO PISAĆ KOD"\); /g,
          "wykonawca tworzy gałąź wg briefu; ",
        );
      }
      if (["mi-sie-web", "mi-sie-recenzji-glm"].includes(slug)) {
        text = fixInReviewSemantics(text);
      }
      if (resolvedOverrides[slug]) {
        text = rewriteFrontmatterSkills(text, resolvedOverrides[slug]);
      }
      if (slug === "in-ynier-wdro-e") {
        text = text.replace(/^- \*\*commit\*\*[^\n]*\n/gm, "");
        text = text.replace(/^- \*\*release\*\*[^\n]*\n/gm, "");
      }
      if (slug === "senior-programista") {
        text = text.replace(/^- \*\*commit\*\* \/ \*\*release\*\*[^\n]*\n/gm, "");
      }
      if (slug === "mi-sie-web" || slug === "mi-sie-recenzji-glm") {
        text = text.replace(/^- \*\*commit\*\*[^\n]*\n/gm, "");
        text = text.replace(/^- \*\*ticket\*\*[^\n]*\n/gm, "");
        if (slug === "mi-sie-web") text = text.replace(/^- \*\*review\*\*[^\n]*\n/gm, "");
        if (slug === "mi-sie-recenzji-glm") {
          text = text.replace(/^- \*\*research\*\*[^\n]*\n/gm, "");
        }
      }
    }

    writeText(path.join(outDir, rel), text);
    written += 1;
  }

  const desiredAgents = agents.map((a) => {
    const skills = resolvedOverrides[a.slug] ?? a.skills ?? [];
    const adapterConfig = { ...(a.adapterConfig ?? {}) };
    if (a.slug === "mi-sie-vault" && adapterConfig.model === "haiku") {
      adapterConfig.model = "claude-haiku-4-5";
    }
    const manageStatus = a.slug === "mi-sie-kodu-codex";
    return {
      slug: a.slug,
      name: a.name,
      role: a.role,
      adapterType: a.adapterType,
      model: adapterConfig.model ?? null,
      // Export status is NOT authoritative for live pause/idle. Only Codex is managed.
      manageStatus,
      ...(manageStatus ? { status: "paused" } : {}),
      skills: skills.map(skillShortName),
      skillKeys: skills,
      reportsToSlug: a.reportsToSlug ?? null,
    };
  });

  const meta = {
    schemaVersion: 1,
    generatedFromExport: path.basename(exportPath),
    exportSha256: createHash("sha256").update(raw).digest("hex"),
    portableAgentCount: desiredAgents.length,
    managedBuiltInCount: 2,
    expectedLiveAgentCount: desiredAgents.length + 2,
    exportWarnings: summarizeExportWarnings(data.warnings ?? []),
  };

  writeText(
    path.join(ROOT, "desired", "agents.json"),
    `${JSON.stringify({ meta, agents: desiredAgents }, null, 2)}\n`,
  );

  const yamlPath = path.join(outDir, ".paperclip.yaml");
  if (existsSync(yamlPath)) {
    let yaml = readFileSync(yamlPath, "utf8");
    yaml = yaml.replace(
      /(mi-sie-vault:[\s\S]*?model:\s*")haiku(")/,
      "$1claude-haiku-4-5$2",
    );
    writeFileSync(yamlPath, sanitizePaperclipYaml(yaml), "utf8");
  }

  console.log(
    JSON.stringify(
      {
        outDir,
        agents: desiredAgents.length,
        filesWritten: written,
        skillsSkipped: skippedSkills,
        exportSha256: meta.exportSha256,
        exportWarnings: meta.exportWarnings,
        skillOverrides: Object.keys(resolvedOverrides),
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
