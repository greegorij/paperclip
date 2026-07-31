#!/usr/bin/env node
/**
 * classify-pr-ci.mjs
 *
 * Deterministic PR CI mode classifier for cost-aware GitHub Actions.
 * Pure path/label/draft logic — no network, no git, no GitHub API.
 *
 * Modes:
 *   full       — every heavy lane (ready PR, high-risk paths, or ci:full)
 *   selective  — draft PR: only lanes implied by changed paths
 *   docs       — documentation-only: policy only, no monorepo install/build/e2e
 *
 * Precedence: ci:full → high-risk → docs-only → ready (non-draft) → selective
 */

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const FULL_LABEL = "ci:full";

/** Path globs (as anchored regexes) that force the full CI track. */
export const HIGH_RISK_PATTERNS = Object.freeze([
  { id: "workflows", re: /^\.github\/workflows\// },
  { id: "github-actions", re: /^\.github\/actions\// },
  { id: "lockfile", re: /(^|\/)pnpm-lock\.yaml$/ },
  { id: "manifest-package-json", re: /(^|\/)package\.json$/ },
  { id: "manifest-workspace", re: /^pnpm-workspace\.yaml$/ },
  { id: "manifest-npmrc", re: /^\.npmrc$/ },
  { id: "manifest-pnpmfile", re: /^pnpmfile\.(cjs|js|mjs)$/ },
  { id: "patches", re: /^patches\// },
  // Auth/authz: directories (server/src/auth/) and leaf modules
  // (middleware/auth.ts, routes/authz.ts, services/authorization.ts, …).
  { id: "auth", re: /(^|\/|[-_])auth([._/-]|$)/i },
  { id: "authz", re: /authz/i },
  { id: "authorization", re: /authorization/i },
  { id: "oauth", re: /(^|\/|[-_])oauth([._-]|$)/i },
  // Secrets: secrets/ trees plus secret* modules (routes/secrets.ts,
  // agent-secret-bindings.ts, validators/secret.ts, …).
  { id: "secrets", re: /(^|\/|[-_])secrets?([._/-]|$)/i },
  { id: "migrations-db", re: /^packages\/db\// },
  { id: "migrations-plugin", re: /(^|\/)migrations\// },
  // Billing/budget hard-stop surfaces plus adjacent cost/finance/spend paths
  // that live outside packages/db (services/budgets.ts, routes/costs.ts, …).
  { id: "billing", re: /(^|\/|[-_])(billing|budget)/i },
  { id: "costs", re: /(^|\/|[-_])costs?([._-]|$)/i },
  { id: "finance", re: /(^|\/|[-_])finance([._-]|$)/i },
  { id: "spend", re: /(^|\/|[-_])(spend|monthly-spend)([._-]|$)/i },
  {
    id: "release-scripts",
    re: /^scripts\/(release|create-github-release|rollback-latest|build-npm|prepare-bundled-package|bootstrap-npm-package|release-)/,
  },
  { id: "release-workflow", re: /^\.github\/workflows\/release/ },
  { id: "adapters", re: /^packages\/adapters\// },
  { id: "adapter-utils", re: /^packages\/adapter-utils\// },
  // Tool gateway/access: hyphen and underscore forms, including
  // tool-access-policy.ts and schema/tool_access.ts.
  { id: "tool-gateway", re: /(^|\/)tool[-_]gateway([._/-]|$)/ },
  { id: "tool-access", re: /(^|\/)tool[-_]access([._/-]|$)/ },
  { id: "heartbeat-runtime", re: /^server\/src\/services\/heartbeat/ },
  {
    id: "shared-root-config",
    re: /^(tsconfig.*\.json|vitest\.config\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s|Dockerfile(\.|$)|docker-compose.*\.ya?ml|\.nvmrc)$/,
  },
  {
    id: "shared-package-config",
    re: /^(packages|server|ui|cli)\/.*\/(tsconfig.*\.json|vitest\.config\.[cm]?[jt]s)$/,
  },
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

const DOC_PATH_PREFIXES = Object.freeze(["doc/", "docs/", ".github/ISSUE_TEMPLATE/"]);

const DOC_EXACT = new Set([
  "LICENSE",
  "LICENSE.md",
  "CHANGELOG.md",
  "CHANGELOG",
  "AUTHORS",
  "NOTICE",
  "AGENTS.md",
  "DESIGN.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "README.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/CODEOWNERS",
]);

/**
 * @typedef {'docs' | 'selective' | 'full'} CiMode
 * @typedef {{
 *   mode: CiMode,
 *   reason: string,
 *   run_core: boolean,
 *   run_server: boolean,
 *   run_workspaces: boolean,
 *   run_ui: boolean,
 *   run_packages: boolean,
 *   run_cli: boolean,
 *   run_build: boolean,
 *   run_e2e: boolean,
 *   run_canary: boolean,
 *   high_risk: string[],
 *   areas: string[],
 * }} CiClassification
 */

/** Former verify_core sub-lane flags (still emitted for selective step gates). */
export const CORE_SUB_LANE_FLAGS = Object.freeze([
  "run_server",
  "run_ui",
  "run_packages",
  "run_cli",
]);

/** Workspaces job sub-lane flags (ui / packages / cli). */
export const WORKSPACES_SUB_LANE_FLAGS = Object.freeze([
  "run_ui",
  "run_packages",
  "run_cli",
]);

export function normalizePath(filePath) {
  return String(filePath ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

export function isDocsPath(filePath) {
  const p = normalizePath(filePath);
  if (!p) return false;
  if (DOC_EXACT.has(p)) return true;
  if (DOC_PATH_PREFIXES.some((prefix) => p.startsWith(prefix))) return true;
  // Keep workflow/action YAML out of the docs bucket even under .github/.
  if (
    p.startsWith(".github/") &&
    !p.startsWith(".github/ISSUE_TEMPLATE/") &&
    p !== ".github/PULL_REQUEST_TEMPLATE.md" &&
    p !== ".github/CODEOWNERS"
  ) {
    return false;
  }
  const ext = path.posix.extname(p).toLowerCase();
  return DOC_EXTENSIONS.has(ext);
}

export function matchHighRisk(filePath) {
  const p = normalizePath(filePath);
  const hits = [];
  for (const rule of HIGH_RISK_PATTERNS) {
    if (rule.re.test(p)) hits.push(rule.id);
  }
  return hits;
}

/**
 * Map a changed path onto coarse product areas used for selective lanes.
 * Returns [] for docs / ignorable policy-only paths.
 */
export function classifyPathAreas(filePath) {
  const p = normalizePath(filePath);
  if (!p || isDocsPath(p)) return [];

  if (
    p.startsWith("tests/e2e/") ||
    p.startsWith("tests/release-smoke/") ||
    p.startsWith("tests/storybook-visual/")
  ) {
    return ["e2e"];
  }
  if (p.startsWith("ui/")) return ["ui"];
  if (p.startsWith("server/")) return ["server"];
  if (p.startsWith("cli/")) return ["cli"];
  if (p.startsWith("packages/")) return ["packages"];
  if (p.startsWith("tests/")) return ["server"];
  // Script / CI helper changes are covered by the always-on policy job.
  if (p.startsWith("scripts/") || p.startsWith(".github/scripts/")) return ["policy"];
  if (p.startsWith("ops/") || p.startsWith("evals/")) return ["policy"];
  // Unknown non-doc paths: treat as core application surface.
  return ["unknown"];
}

function unique(values) {
  return [...new Set(values)];
}

function emptyCoreSubLanes() {
  return {
    run_server: false,
    run_ui: false,
    run_packages: false,
    run_cli: false,
  };
}

function lanesForAreas(areas) {
  const set = new Set(areas);
  // Unknown non-doc paths are handled as fail-safe full by classifyPrCi;
  // this helper only covers known selective areas.
  const run_server = set.has("server");
  const run_ui = set.has("ui");
  const run_packages = set.has("packages");
  const run_cli = set.has("cli");
  const run_workspaces = run_ui || run_packages || run_cli;
  const run_core = run_server || run_workspaces;
  let run_build = false;
  let run_e2e = false;
  const run_canary = false;

  if (set.has("packages") || set.has("ui") || set.has("e2e")) {
    run_build = true;
  }
  if (set.has("ui") || set.has("e2e")) {
    run_e2e = true;
  }

  // policy-only areas leave all heavy lanes off.
  return {
    run_core,
    run_server,
    run_workspaces,
    run_ui,
    run_packages,
    run_cli,
    run_build,
    run_e2e,
    run_canary,
  };
}

function fullLanes(reason) {
  return {
    mode: /** @type {CiMode} */ ("full"),
    reason,
    run_core: true,
    run_server: true,
    run_workspaces: true,
    run_ui: true,
    run_packages: true,
    run_cli: true,
    run_build: true,
    run_e2e: true,
    run_canary: true,
    high_risk: [],
    areas: [],
  };
}

/**
 * @param {{
 *   paths?: string[],
 *   draft?: boolean,
 *   labels?: string[],
 * }} input
 * @returns {CiClassification}
 */
export function classifyPrCi(input = {}) {
  const paths = (input.paths ?? []).map(normalizePath).filter(Boolean);
  const labels = (input.labels ?? []).map((label) => String(label).trim().toLowerCase()).filter(Boolean);
  const draft = Boolean(input.draft);

  if (labels.includes(FULL_LABEL.toLowerCase())) {
    return {
      ...fullLanes(`label ${FULL_LABEL} requested the full CI track`),
      high_risk: [],
      areas: unique(paths.flatMap(classifyPathAreas)),
    };
  }

  const highRiskHits = [];
  for (const filePath of paths) {
    for (const id of matchHighRisk(filePath)) {
      highRiskHits.push(`${id}:${filePath}`);
    }
  }
  if (highRiskHits.length > 0) {
    const sample = highRiskHits.slice(0, 5).join(", ");
    const more = highRiskHits.length > 5 ? ` (+${highRiskHits.length - 5} more)` : "";
    return {
      ...fullLanes(`high-risk paths force the full CI track: ${sample}${more}`),
      high_risk: highRiskHits,
      areas: unique(paths.flatMap(classifyPathAreas)),
    };
  }

  const nonDocs = paths.filter((p) => !isDocsPath(p));
  if (paths.length > 0 && nonDocs.length === 0) {
    return {
      mode: "docs",
      reason: "documentation-only changes: policy checks only (no monorepo install, build, or e2e)",
      run_core: false,
      run_workspaces: false,
      ...emptyCoreSubLanes(),
      run_build: false,
      run_e2e: false,
      run_canary: false,
      high_risk: [],
      areas: [],
    };
  }

  if (!draft) {
    return {
      ...fullLanes("pull request is ready for review/merge: full CI track"),
      high_risk: [],
      areas: unique(paths.flatMap(classifyPathAreas)),
    };
  }

  // Draft + non-docs + not high-risk → selective path-based lanes.
  const areas = unique(paths.flatMap(classifyPathAreas));
  // Unknown non-doc paths: fail-safe full track (do not invent a selective subset).
  if (areas.includes("unknown")) {
    return {
      ...fullLanes("unknown non-doc paths force the full CI track (fail-safe)"),
      high_risk: [],
      areas,
    };
  }
  const lanes = lanesForAreas(areas);
  const active = [
    lanes.run_server ? "server" : null,
    lanes.run_ui ? "ui" : null,
    lanes.run_packages ? "packages" : null,
    lanes.run_cli ? "cli" : null,
    lanes.run_build ? "build" : null,
    lanes.run_e2e ? "e2e" : null,
    lanes.run_canary ? "canary" : null,
  ].filter(Boolean);

  if (active.length === 0) {
    return {
      mode: "selective",
      reason: `draft PR with policy-covered paths only (areas: ${areas.join(", ") || "none"}): skipping heavy lanes`,
      ...lanes,
      high_risk: [],
      areas,
    };
  }

  return {
    mode: "selective",
    reason: `draft PR selective track for areas [${areas.join(", ")}]: running ${active.join(", ")}`,
    ...lanes,
    high_risk: [],
    areas,
  };
}

/**
 * Parse a classifier lane flag.
 * Fail-closed: only exact conscious booleans / 0|1 are accepted. Empty or
 * unknown values must not be treated as an intentional "lane off".
 *
 * @param {unknown} value
 * @returns {boolean | null} true/false when valid; null when missing/invalid
 */
export function parseRunFlag(value) {
  if (value === true || value === "1" || value === "true") return true;
  if (value === false || value === "0" || value === "false") return false;
  return null;
}

/**
 * Gate helper for required aggregate jobs (`verify`, `e2e`).
 * When a heavy lane was intentionally not selected, `skipped` counts as success
 * so branch protection does not wait forever on a missing check name.
 *
 * @param {{ run: boolean | string, result: string }} input
 */
export function checkLaneAggregate(input) {
  const run = parseRunFlag(input.run);
  const result = String(input.result ?? "");
  if (run === null) {
    return {
      ok: false,
      detail: `lane run flag missing or invalid (${JSON.stringify(input.run)}); refuse to treat as intentional omission`,
    };
  }
  if (run) {
    return {
      ok: result === "success",
      detail: `lane required; job result=${result}`,
    };
  }
  // Intentional omission: skipped (job if:) or success (noop job) are fine.
  // failure/cancelled still fail the aggregate.
  const ok = result === "skipped" || result === "success";
  return {
    ok,
    detail: `lane not selected; accepting result=${result}`,
  };
}

/**
 * @param {{
 *   run_server: boolean | string,
 *   run_workspaces: boolean | string,
 *   run_build: boolean | string,
 *   run_e2e: boolean | string,
 *   server_general_result: string,
 *   server_serialized_result: string,
 *   workspaces_result: string,
 *   build_result: string,
 *   e2e_result: string,
 * }} input
 */
export function checkVerifyAggregate(input) {
  const checks = [
    [
      "server_general",
      checkLaneAggregate({ run: input.run_server, result: input.server_general_result }),
    ],
    [
      "server_serialized",
      checkLaneAggregate({ run: input.run_server, result: input.server_serialized_result }),
    ],
    [
      "workspaces",
      checkLaneAggregate({ run: input.run_workspaces, result: input.workspaces_result }),
    ],
    ["build", checkLaneAggregate({ run: input.run_build, result: input.build_result })],
    ["e2e", checkLaneAggregate({ run: input.run_e2e, result: input.e2e_result })],
  ];
  const failed = checks.filter(([, c]) => !c.ok);
  return {
    ok: failed.length === 0,
    details: checks.map(([name, c]) => `${name}: ${c.detail}`),
    failed: failed.map(([name]) => name),
  };
}

export function toGithubOutputs(classification) {
  return {
    mode: classification.mode,
    reason: classification.reason,
    run_core: classification.run_core ? "1" : "0",
    run_server: classification.run_server ? "1" : "0",
    run_workspaces: classification.run_workspaces ? "1" : "0",
    run_ui: classification.run_ui ? "1" : "0",
    run_packages: classification.run_packages ? "1" : "0",
    run_cli: classification.run_cli ? "1" : "0",
    run_build: classification.run_build ? "1" : "0",
    run_e2e: classification.run_e2e ? "1" : "0",
    run_canary: classification.run_canary ? "1" : "0",
    // Dynamic matrix helper for callers that still want a skip entry; the PR
    // workflow gates e2e_shards with run_e2e instead so docs/selective tracks
    // do not pay for a noop runner.
    e2e_matrix: JSON.stringify(
      classification.run_e2e
        ? [
            { shard_index: 0, shard_count: 2, shard_label: "1/2", skip: false },
            { shard_index: 1, shard_count: 2, shard_label: "2/2", skip: false },
          ]
        : [{ shard_index: 0, shard_count: 1, shard_label: "skipped", skip: true }],
    ),
  };
}

/**
 * Fail-closed validation for verify_server_general / verify_server_serialized
 * lane flags. Empty/invalid flags must not look like intentional omissions.
 *
 * @param {{
 *   mode: string,
 *   run_server: boolean | string,
 * }} input
 */
export function checkServerLaneFlags(input) {
  const mode = String(input.mode ?? "");
  const runServer = parseRunFlag(input.run_server);
  if (runServer === null) {
    return {
      ok: false,
      details: [
        `run_server: missing or invalid (${JSON.stringify(input.run_server)}); refuse to treat as intentional omission`,
      ],
      failed: ["run_server"],
    };
  }
  const details = [`run_server=${runServer ? "1" : "0"}`];

  if (mode === "full" || mode === "selective") {
    if (!runServer) {
      return {
        ok: false,
        details: [
          ...details,
          `server lane job reached with run_server off (mode=${mode})`,
        ],
        failed: ["run_server"],
      };
    }
    return { ok: true, details, failed: [] };
  }

  return {
    ok: false,
    details: [...details, `unexpected mode for server lanes: ${JSON.stringify(mode)}`],
    failed: ["mode"],
  };
}

/**
 * Fail-closed validation for verify_workspaces sub-lane flags.
 * Empty/invalid flags must not look like intentional omissions.
 *
 * @param {{
 *   mode: string,
 *   run_ui: boolean | string,
 *   run_packages: boolean | string,
 *   run_cli: boolean | string,
 * }} input
 */
export function checkWorkspacesLaneFlags(input) {
  const mode = String(input.mode ?? "");
  const parsed = {};
  const details = [];
  for (const key of WORKSPACES_SUB_LANE_FLAGS) {
    const flag = parseRunFlag(input[key]);
    if (flag === null) {
      return {
        ok: false,
        details: [
          `${key}: missing or invalid (${JSON.stringify(input[key])}); refuse to treat as intentional omission`,
        ],
        failed: [key],
      };
    }
    parsed[key] = flag;
    details.push(`${key}=${flag ? "1" : "0"}`);
  }

  if (mode === "full") {
    const unset = WORKSPACES_SUB_LANE_FLAGS.filter((key) => !parsed[key]);
    if (unset.length > 0) {
      return {
        ok: false,
        details: [
          ...details,
          `full track requires every workspaces sub-lane on; missing: ${unset.join(", ")}`,
        ],
        failed: unset,
      };
    }
    return { ok: true, details, failed: [] };
  }

  if (mode === "selective") {
    const any = WORKSPACES_SUB_LANE_FLAGS.some((key) => parsed[key]);
    if (!any) {
      return {
        ok: false,
        details: [...details, "selective verify_workspaces reached with every workspaces sub-lane off"],
        failed: [...WORKSPACES_SUB_LANE_FLAGS],
      };
    }
    return { ok: true, details, failed: [] };
  }

  return {
    ok: false,
    details: [...details, `unexpected mode for verify_workspaces sub-lanes: ${JSON.stringify(mode)}`],
    failed: ["mode"],
  };
}

/**
 * Fail-closed validation spanning former verify_core sub-lane flags.
 * Kept for combined checks; prefer checkServerLaneFlags / checkWorkspacesLaneFlags
 * at job entry.
 *
 * @param {{
 *   mode: string,
 *   run_server: boolean | string,
 *   run_ui: boolean | string,
 *   run_packages: boolean | string,
 *   run_cli: boolean | string,
 * }} input
 */
export function checkCoreLaneFlags(input) {
  const mode = String(input.mode ?? "");
  const parsed = {};
  const details = [];
  for (const key of CORE_SUB_LANE_FLAGS) {
    const flag = parseRunFlag(input[key]);
    if (flag === null) {
      return {
        ok: false,
        details: [
          `${key}: missing or invalid (${JSON.stringify(input[key])}); refuse to treat as intentional omission`,
        ],
        failed: [key],
      };
    }
    parsed[key] = flag;
    details.push(`${key}=${flag ? "1" : "0"}`);
  }

  if (mode === "full") {
    const unset = CORE_SUB_LANE_FLAGS.filter((key) => !parsed[key]);
    if (unset.length > 0) {
      return {
        ok: false,
        details: [...details, `full track requires every core sub-lane on; missing: ${unset.join(", ")}`],
        failed: unset,
      };
    }
    return { ok: true, details, failed: [] };
  }

  if (mode === "selective") {
    const any = CORE_SUB_LANE_FLAGS.some((key) => parsed[key]);
    if (!any) {
      return {
        ok: false,
        details: [...details, "selective core lanes reached with every core sub-lane off"],
        failed: [...CORE_SUB_LANE_FLAGS],
      };
    }
    return { ok: true, details, failed: [] };
  }

  return {
    ok: false,
    details: [...details, `unexpected mode for core sub-lanes: ${JSON.stringify(mode)}`],
    failed: ["mode"],
  };
}

export function formatClassificationLog(classification) {
  const outputs = toGithubOutputs(classification);
  const lines = [
    `CI track: ${classification.mode}`,
    `Reason: ${classification.reason}`,
    `Lanes: core=${outputs.run_core} server=${outputs.run_server} workspaces=${outputs.run_workspaces} ui=${outputs.run_ui} packages=${outputs.run_packages} cli=${outputs.run_cli} build=${outputs.run_build} e2e=${outputs.run_e2e} canary=${outputs.run_canary}`,
  ];
  if (classification.areas.length > 0) {
    lines.push(`Areas: ${classification.areas.join(", ")}`);
  }
  if (classification.high_risk.length > 0) {
    lines.push(`High-risk hits: ${classification.high_risk.slice(0, 10).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = {
    command: "classify",
    draft: false,
    labels: /** @type {string[]} */ ([]),
    paths: /** @type {string[]} */ ([]),
    githubOutput: null,
    mode: "",
    run_server: "0",
    run_workspaces: "0",
    run_ui: "0",
    run_packages: "0",
    run_cli: "0",
    run_build: "0",
    run_e2e: "0",
    server_general_result: "skipped",
    server_serialized_result: "skipped",
    workspaces_result: "skipped",
    build_result: "skipped",
    e2e_result: "skipped",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (
      a === "classify" ||
      a === "check-verify" ||
      a === "check-e2e" ||
      a === "check-server-lanes" ||
      a === "check-workspaces-lanes" ||
      a === "check-core-lanes" ||
      a === "help"
    ) {
      args.command = a;
      continue;
    }
    if (a === "--draft") {
      args.draft = ["1", "true", "yes"].includes(String(argv[++i]).toLowerCase());
      continue;
    }
    if (a === "--label") {
      args.labels.push(String(argv[++i] ?? ""));
      continue;
    }
    if (a === "--path") {
      args.paths.push(String(argv[++i] ?? ""));
      continue;
    }
    if (a === "--paths-file") {
      const file = String(argv[++i] ?? "");
      if (file) {
        for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
          if (line.trim()) args.paths.push(line.trim());
        }
      }
      continue;
    }
    if (a === "--github-output") {
      args.githubOutput = String(argv[++i] ?? "");
      continue;
    }
    if (a === "--mode") {
      args.mode = String(argv[++i] ?? "");
      continue;
    }
    if (a === "--run-server") {
      args.run_server = String(argv[++i] ?? "0");
      continue;
    }
    if (a === "--run-workspaces") {
      args.run_workspaces = String(argv[++i] ?? "0");
      continue;
    }
    if (a === "--run-ui") {
      args.run_ui = String(argv[++i] ?? "0");
      continue;
    }
    if (a === "--run-packages") {
      args.run_packages = String(argv[++i] ?? "0");
      continue;
    }
    if (a === "--run-cli") {
      args.run_cli = String(argv[++i] ?? "0");
      continue;
    }
    if (a === "--run-build") {
      args.run_build = String(argv[++i] ?? "0");
      continue;
    }
    if (a === "--run-e2e") {
      args.run_e2e = String(argv[++i] ?? "0");
      continue;
    }
    if (a === "--server-general-result") {
      args.server_general_result = String(argv[++i] ?? "");
      continue;
    }
    if (a === "--server-serialized-result") {
      args.server_serialized_result = String(argv[++i] ?? "");
      continue;
    }
    if (a === "--workspaces-result") {
      args.workspaces_result = String(argv[++i] ?? "");
      continue;
    }
    if (a === "--build-result") {
      args.build_result = String(argv[++i] ?? "");
      continue;
    }
    if (a === "--e2e-result" || a === "--result") {
      args.e2e_result = String(argv[++i] ?? "");
      continue;
    }
    if (a === "--help" || a === "-h") {
      args.command = "help";
      continue;
    }
    if (a === "--") {
      args.paths.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("-")) {
      args.paths.push(a);
    }
  }
  return args;
}

function writeGithubOutput(filePath, outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => {
    const text = String(value);
    if (text.includes("\n")) {
      return `${key}<<EOF\n${text}\nEOF`;
    }
    return `${key}=${text}`;
  });
  appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function main(argv) {
  const args = parseArgs(argv);

  if (args.command === "help") {
    process.stdout.write(`Usage:
  classify-pr-ci.mjs classify [--draft true|false] [--label NAME]... [--path FILE]...
  classify-pr-ci.mjs check-verify --run-server 0|1 --run-workspaces 0|1 --run-build 0|1 --run-e2e 0|1 \\
      --server-general-result RESULT --server-serialized-result RESULT \\
      --workspaces-result RESULT --build-result RESULT --e2e-result RESULT
  classify-pr-ci.mjs check-e2e --run-e2e 0|1 --result RESULT
  classify-pr-ci.mjs check-server-lanes --mode full|selective --run-server 0|1
  classify-pr-ci.mjs check-workspaces-lanes --mode full|selective \\
      --run-ui 0|1 --run-packages 0|1 --run-cli 0|1
`);
    return;
  }

  if (args.command === "check-server-lanes") {
    const verdict = checkServerLaneFlags({
      mode: args.mode,
      run_server: args.run_server,
    });
    process.stdout.write(`${verdict.details.join("\n")}\n`);
    if (!verdict.ok) {
      process.stderr.write(`server lane flags failed: ${verdict.failed.join(", ")}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "check-workspaces-lanes") {
    const verdict = checkWorkspacesLaneFlags({
      mode: args.mode,
      run_ui: args.run_ui,
      run_packages: args.run_packages,
      run_cli: args.run_cli,
    });
    process.stdout.write(`${verdict.details.join("\n")}\n`);
    if (!verdict.ok) {
      process.stderr.write(`workspaces lane flags failed: ${verdict.failed.join(", ")}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "check-core-lanes") {
    const verdict = checkCoreLaneFlags({
      mode: args.mode,
      run_server: args.run_server,
      run_ui: args.run_ui,
      run_packages: args.run_packages,
      run_cli: args.run_cli,
    });
    process.stdout.write(`${verdict.details.join("\n")}\n`);
    if (!verdict.ok) {
      process.stderr.write(`core lane flags failed: ${verdict.failed.join(", ")}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "check-verify") {
    const verdict = checkVerifyAggregate({
      run_server: args.run_server,
      run_workspaces: args.run_workspaces,
      run_build: args.run_build,
      run_e2e: args.run_e2e,
      server_general_result: args.server_general_result,
      server_serialized_result: args.server_serialized_result,
      workspaces_result: args.workspaces_result,
      build_result: args.build_result,
      e2e_result: args.e2e_result,
    });
    process.stdout.write(`${verdict.details.join("\n")}\n`);
    if (!verdict.ok) {
      process.stderr.write(`verify aggregate failed: ${verdict.failed.join(", ")}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "check-e2e") {
    const verdict = checkLaneAggregate({ run: args.run_e2e, result: args.e2e_result });
    process.stdout.write(`${verdict.detail}\n`);
    if (!verdict.ok) {
      process.stderr.write("e2e aggregate failed\n");
      process.exitCode = 1;
    }
    return;
  }

  const classification = classifyPrCi({
    paths: args.paths,
    draft: args.draft,
    labels: args.labels,
  });
  const log = formatClassificationLog(classification);
  process.stdout.write(log);

  const outputs = toGithubOutputs(classification);
  if (args.githubOutput) {
    writeGithubOutput(args.githubOutput, outputs);
  } else if (process.env.GITHUB_OUTPUT) {
    writeGithubOutput(process.env.GITHUB_OUTPUT, outputs);
  }

  if (process.env.CLASSIFY_PR_CI_JSON === "1") {
    process.stdout.write(`${JSON.stringify({ classification, outputs }, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
