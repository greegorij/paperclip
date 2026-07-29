#!/usr/bin/env node
/**
 * fleet-preflight.mjs — Deterministic local preflight for fleet-config.yaml
 *
 * Validates that every fleet test case:
 *   1. Has non-empty vars.scenario
 *   2. Has non-empty vars.expectedBehavior
 *   3. Does NOT have a top-level `prompt` key (ignored by Promptfoo 0.121.19)
 *   4. Has a distinct case-specific marker present in scenario or expectedBehavior
 *      (derived from the description field)
 *
 * Also renders the heartbeat-system.txt template for each case with the test
 * vars and verifies the rendered prompt contains non-empty scenario and
 * expectedBehavior content (i.e. no bare {{scenario}} / {{expectedBehavior}}
 * placeholders remain).
 *
 * No network, no paid calls, no cache writes. No external dependencies.
 *
 * Run:
 *   node evals/promptfoo/fleet/scripts/fleet-preflight.mjs
 *
 * Manual echo verification command (renders all cases, no paid calls):
 *   cd evals/promptfoo/fleet
 *   npx promptfoo@0.121.19 eval -c promptfooconfig.yaml \
 *     --providers echo \
 *     --no-write --no-cache \
 *     --filter-pattern '^fleet_config\.'
 *
 * Exit code 0 = all checks passed. Non-zero = one or more failures (details printed).
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLEET_DIR = join(__dirname, "..");
const TESTS_FILE = join(FLEET_DIR, "tests", "fleet-config.yaml");
const TEMPLATE_FILE = join(FLEET_DIR, "..", "prompts", "heartbeat-system.txt");

// ── minimal YAML block-scalar reader ─────────────────────────────────────────
// Rather than pulling in a full YAML parser we do targeted extraction.
// The fleet-config.yaml uses a predictable structure: each case is a YAML
// mapping at the root level. We split on case boundaries (lines starting with
// "- description:") and extract the fields we need with simple regex.

function extractCases(yamlText) {
  // Split into per-case blocks on lines that start a new list item at column 0.
  // Filter out preamble blocks (comment headers) that don't start with "- description:".
  const rawBlocks = yamlText
    .split(/^(?=- description:)/m)
    .filter(b => /^- description:/m.test(b));
  return rawBlocks.map(block => {
    const descMatch = block.match(/^- description:\s*"([^"]+)"|^- description:\s*'([^']+)'|^- description:\s*(.+)/m);
    const description = (descMatch?.[1] ?? descMatch?.[2] ?? descMatch?.[3] ?? "").trim();

    const hasPromptKey = /^\s{0,2}prompt:/m.test(block);

    // Extract a block scalar or flow scalar value for a given key inside vars.
    // Handles: key: | (literal block) and key: > (folded block) and inline scalars.
    function extractVarValue(key) {
      // Match "    key: |" or "    key: >" followed by indented lines, or inline.
      const blockRe = new RegExp(`^[ \\t]{4}${key}:\\s*[|>][-+]?\\n((?:[ \\t]{6,}[^\\n]*\\n)*)`, "m");
      const blockMatch = block.match(blockRe);
      if (blockMatch) {
        // Strip the leading 6 spaces (4 vars indent + 2 content indent) from each line.
        return blockMatch[1].replace(/^[ \t]{6}/gm, "").trim();
      }
      // Inline scalar (single line, possibly quoted).
      const inlineRe = new RegExp(`^[ \\t]{4}${key}:\\s*(.+)`, "m");
      const inlineMatch = block.match(inlineRe);
      if (inlineMatch) {
        return inlineMatch[1].replace(/^['"]|['"]$/g, "").trim();
      }
      return "";
    }

    const scenario = extractVarValue("scenario");
    const expectedBehavior = extractVarValue("expectedBehavior");

    return { description, hasPromptKey, scenario, expectedBehavior, raw: block };
  });
}

function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] !== undefined ? String(vars[key]) : ""
  );
}

/** Extract a short case marker from the description for distinct-content checks. */
function caseMarkerFromDescription(description) {
  const m = description.match(/fleet_config\.([a-z0-9_]+)/i);
  return m ? m[1] : description.slice(0, 40);
}

// ── load files ────────────────────────────────────────────────────────────────

let yamlText;
try {
  yamlText = readFileSync(TESTS_FILE, "utf8");
} catch (err) {
  console.error(`FAIL: cannot read ${TESTS_FILE}: ${err.message}`);
  process.exit(1);
}

let template;
try {
  template = readFileSync(TEMPLATE_FILE, "utf8");
} catch (err) {
  console.error(`FAIL: cannot read ${TEMPLATE_FILE}: ${err.message}`);
  process.exit(1);
}

const cases = extractCases(yamlText);
if (cases.length === 0) {
  console.error(`FAIL: ${TESTS_FILE} produced no cases`);
  process.exit(1);
}

// ── per-case checks ───────────────────────────────────────────────────────────

let failures = 0;

for (let i = 0; i < cases.length; i++) {
  const tc = cases[i];
  const label = `case[${i}] ${tc.description || "(no description)"}`;
  let caseOk = true;

  function fail(msg) {
    console.error(`FAIL ${label}: ${msg}`);
    failures++;
    caseOk = false;
  }

  // 1. No top-level `prompt` key.
  if (tc.hasPromptKey) {
    fail("has top-level 'prompt' key — remove it (ignored by Promptfoo 0.121.19)");
  }

  // 2. Non-empty vars.scenario.
  if (!tc.scenario) {
    fail("vars.scenario is missing or empty");
  }

  // 3. Non-empty vars.expectedBehavior.
  if (!tc.expectedBehavior) {
    fail("vars.expectedBehavior is missing or empty");
  }

  // 4. Distinct case marker in scenario or expectedBehavior.
  const marker = caseMarkerFromDescription(tc.description ?? "");
  if (marker && marker.length > 4 && tc.scenario && tc.expectedBehavior) {
    const tokens = marker.replace(/_/g, " ").split(" ").filter(t => t.length > 3);
    const combined = (tc.scenario + " " + tc.expectedBehavior).toLowerCase();
    const anyToken = tokens.some(t => combined.includes(t.toLowerCase()));
    if (!anyToken) {
      fail(
        `scenario+expectedBehavior does not contain any case-specific token from "${marker}" ` +
        `(tokens: ${JSON.stringify(tokens)})`
      );
    }
  }

  // 5. Render template and verify no bare placeholders remain.
  const fakeVars = { scenario: tc.scenario, expectedBehavior: tc.expectedBehavior };
  const rendered = renderTemplate(template, fakeVars);

  if (/\{\{scenario\}\}/.test(rendered)) {
    fail("rendered prompt still contains bare {{scenario}} placeholder");
  }
  if (/\{\{expectedBehavior\}\}/.test(rendered)) {
    fail("rendered prompt still contains bare {{expectedBehavior}} placeholder");
  }

  // 6. Rendered sections are non-empty.
  const scenarioSection = rendered.match(/Scenario under evaluation:\s*([\s\S]*?)(?=\n\nExpected behavior)/)?.[1]?.trim();
  if (scenarioSection !== undefined && !scenarioSection) {
    fail("rendered 'Scenario under evaluation' section is empty after template substitution");
  }
  const expectedSection = rendered.match(/Expected behavior focus:\s*([\s\S]*?)(?=\n\nThe Heartbeat)/)?.[1]?.trim();
  if (expectedSection !== undefined && !expectedSection) {
    fail("rendered 'Expected behavior focus' section is empty after template substitution");
  }

  if (caseOk) {
    console.log(`OK  ${label}`);
  }
}

// ── summary ───────────────────────────────────────────────────────────────────

const passed = cases.length - (failures > 0 ? failures : 0);
console.log(`\n${cases.length - Math.min(failures, cases.length)}/${cases.length} cases passed preflight.`);
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("All preflight checks passed.");
}
