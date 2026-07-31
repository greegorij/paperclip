import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CORE_SUB_LANE_FLAGS,
  FULL_LABEL,
  WORKSPACES_SUB_LANE_FLAGS,
  checkCoreLaneFlags,
  checkLaneAggregate,
  checkServerLaneFlags,
  checkVerifyAggregate,
  checkWorkspacesLaneFlags,
  classifyPathAreas,
  classifyPrCi,
  isDocsPath,
  matchHighRisk,
  parseRunFlag,
  toGithubOutputs,
} from "../classify-pr-ci.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "classify-pr-ci.mjs");

test("isDocsPath recognizes markdown and doc trees", () => {
  assert.equal(isDocsPath("doc/GOAL.md"), true);
  assert.equal(isDocsPath("docs/guide.mdx"), true);
  assert.equal(isDocsPath("README.md"), true);
  assert.equal(isDocsPath("AGENTS.md"), true);
  assert.equal(isDocsPath(".github/PULL_REQUEST_TEMPLATE.md"), true);
  assert.equal(isDocsPath("server/src/index.ts"), false);
  assert.equal(isDocsPath(".github/workflows/pr.yml"), false);
});

test("matchHighRisk covers workflows, manifests, auth, secrets, db, billing, release, adapters, tool gateway", () => {
  assert.ok(matchHighRisk(".github/workflows/pr.yml").includes("workflows"));
  assert.ok(matchHighRisk("package.json").includes("manifest-package-json"));
  assert.ok(matchHighRisk("packages/shared/package.json").includes("manifest-package-json"));
  assert.ok(matchHighRisk("pnpm-lock.yaml").includes("lockfile"));
  assert.ok(matchHighRisk("server/src/auth/better-auth.ts").includes("auth"));
  assert.ok(matchHighRisk("server/src/middleware/auth.ts").includes("auth"));
  assert.ok(matchHighRisk("server/src/routes/authz.ts").includes("authz"));
  assert.ok(matchHighRisk("server/src/services/authorization.ts").includes("authorization"));
  assert.ok(matchHighRisk("server/src/agent-auth-jwt.ts").includes("auth"));
  assert.ok(matchHighRisk("server/src/secrets/types.ts").includes("secrets"));
  assert.ok(matchHighRisk("server/src/routes/secrets.ts").includes("secrets"));
  assert.ok(matchHighRisk("server/src/services/agent-secret-bindings.ts").includes("secrets"));
  assert.ok(matchHighRisk("packages/shared/src/validators/secret.ts").includes("secrets"));
  assert.ok(matchHighRisk("packages/db/src/migrations/0194_cost_events_heartbeat_run_unique.sql").includes("migrations-db"));
  assert.ok(matchHighRisk("packages/adapter-utils/src/billing.ts").includes("billing"));
  assert.ok(matchHighRisk("server/src/services/budgets.ts").includes("billing"));
  assert.ok(matchHighRisk("server/src/services/costs.ts").includes("costs"));
  assert.ok(matchHighRisk("server/src/services/finance.ts").includes("finance"));
  assert.ok(matchHighRisk("packages/shared/src/types/budget.ts").includes("billing"));
  assert.ok(matchHighRisk("scripts/release.sh").includes("release-scripts"));
  assert.ok(matchHighRisk("packages/adapters/hermes/src/index.ts").includes("adapters"));
  assert.ok(matchHighRisk("server/src/services/tool-gateway.ts").includes("tool-gateway"));
  assert.ok(matchHighRisk("server/src/services/tool-access-policy.ts").includes("tool-access"));
  assert.ok(matchHighRisk("packages/db/src/schema/tool_access.ts").includes("tool-access"));
  assert.ok(matchHighRisk("server/src/services/heartbeat.ts").includes("heartbeat-runtime"));
  assert.deepEqual(matchHighRisk("ui/src/pages/board.tsx"), []);
});

test("classifyPathAreas maps product surfaces", () => {
  assert.deepEqual(classifyPathAreas("server/src/routes/issues.ts"), ["server"]);
  assert.deepEqual(classifyPathAreas("ui/src/App.tsx"), ["ui"]);
  assert.deepEqual(classifyPathAreas("packages/shared/src/index.ts"), ["packages"]);
  assert.deepEqual(classifyPathAreas("tests/e2e/onboarding.spec.ts"), ["e2e"]);
  assert.deepEqual(classifyPathAreas("scripts/classify-pr-ci.mjs"), ["policy"]);
  assert.deepEqual(classifyPathAreas("doc/GOAL.md"), []);
});

test("docs-only changes select the docs track even when the PR is ready", () => {
  const result = classifyPrCi({
    draft: false,
    paths: ["doc/GOAL.md", "README.md", "docs/intro.mdx"],
  });
  assert.equal(result.mode, "docs");
  assert.equal(result.run_core, false);
  assert.equal(result.run_server, false);
  assert.equal(result.run_workspaces, false);
  assert.equal(result.run_ui, false);
  assert.equal(result.run_packages, false);
  assert.equal(result.run_cli, false);
  assert.equal(result.run_build, false);
  assert.equal(result.run_e2e, false);
  assert.equal(result.run_canary, false);
  assert.match(result.reason, /documentation-only/i);
});

test("ready non-docs PR selects the full track", () => {
  const result = classifyPrCi({
    draft: false,
    paths: ["server/src/routes/issues.ts"],
  });
  assert.equal(result.mode, "full");
  assert.equal(result.run_core, true);
  assert.equal(result.run_server, true);
  assert.equal(result.run_workspaces, true);
  assert.equal(result.run_ui, true);
  assert.equal(result.run_packages, true);
  assert.equal(result.run_cli, true);
  assert.equal(result.run_build, true);
  assert.equal(result.run_e2e, true);
  assert.equal(result.run_canary, true);
});

test("draft server-only PR selects server lane only (no workspaces job)", () => {
  const result = classifyPrCi({
    draft: true,
    paths: ["server/src/routes/issues.ts"],
  });
  assert.equal(result.mode, "selective");
  assert.equal(result.run_core, true);
  assert.equal(result.run_server, true);
  assert.equal(result.run_workspaces, false);
  assert.equal(result.run_ui, false);
  assert.equal(result.run_packages, false);
  assert.equal(result.run_cli, false);
  assert.equal(result.run_build, false);
  assert.equal(result.run_e2e, false);
  assert.equal(result.run_canary, false);
  assert.match(result.reason, /selective/i);
});

test("draft ui PR selects workspaces ui sub-lane plus build and e2e", () => {
  const result = classifyPrCi({
    draft: true,
    paths: ["ui/src/pages/board.tsx"],
  });
  assert.equal(result.mode, "selective");
  assert.equal(result.run_core, true);
  assert.equal(result.run_server, false);
  assert.equal(result.run_workspaces, true);
  assert.equal(result.run_ui, true);
  assert.equal(result.run_packages, false);
  assert.equal(result.run_cli, false);
  assert.equal(result.run_build, true);
  assert.equal(result.run_e2e, true);
  assert.equal(result.run_canary, false);
});

test("draft packages PR selects workspaces packages sub-lane + build without e2e or canary", () => {
  const result = classifyPrCi({
    draft: true,
    paths: ["packages/shared/src/index.ts"],
  });
  assert.equal(result.mode, "selective");
  assert.equal(result.run_core, true);
  assert.equal(result.run_server, false);
  assert.equal(result.run_workspaces, true);
  assert.equal(result.run_ui, false);
  assert.equal(result.run_packages, true);
  assert.equal(result.run_cli, false);
  assert.equal(result.run_build, true);
  assert.equal(result.run_e2e, false);
  assert.equal(result.run_canary, false);
});

test("draft cli-only PR selects workspaces cli sub-lane only", () => {
  const result = classifyPrCi({
    draft: true,
    paths: ["cli/src/index.ts"],
  });
  assert.equal(result.mode, "selective");
  assert.equal(result.run_core, true);
  assert.equal(result.run_server, false);
  assert.equal(result.run_workspaces, true);
  assert.equal(result.run_ui, false);
  assert.equal(result.run_packages, false);
  assert.equal(result.run_cli, true);
  assert.equal(result.run_build, false);
  assert.equal(result.run_e2e, false);
});

test("draft unknown non-doc path is fail-safe full, not selective", () => {
  const result = classifyPrCi({
    draft: true,
    paths: ["mystery/tooling/foo.ts"],
  });
  assert.equal(result.mode, "full");
  assert.equal(result.run_core, true);
  assert.equal(result.run_server, true);
  assert.equal(result.run_workspaces, true);
  assert.equal(result.run_build, true);
  assert.equal(result.run_e2e, true);
  assert.deepEqual(result.areas, ["unknown"]);
  assert.match(result.reason, /unknown non-doc|fail-safe/i);
});

test("draft policy-only script changes skip heavy lanes", () => {
  const result = classifyPrCi({
    draft: true,
    paths: ["scripts/classify-pr-ci.mjs"],
  });
  assert.equal(result.mode, "selective");
  assert.equal(result.run_core, false);
  assert.equal(result.run_server, false);
  assert.equal(result.run_workspaces, false);
  assert.equal(result.run_ui, false);
  assert.equal(result.run_packages, false);
  assert.equal(result.run_cli, false);
  assert.equal(result.run_build, false);
  assert.equal(result.run_e2e, false);
});

test("draft e2e-spec PR selects build + e2e (and core stays off for pure e2e trees)", () => {
  const result = classifyPrCi({
    draft: true,
    paths: ["tests/e2e/onboarding.spec.ts"],
  });
  assert.equal(result.mode, "selective");
  assert.equal(result.run_core, false);
  assert.equal(result.run_server, false);
  assert.equal(result.run_workspaces, false);
  assert.equal(result.run_build, true);
  assert.equal(result.run_e2e, true);
});

test("mixed docs + code is not docs-only", () => {
  const result = classifyPrCi({
    draft: true,
    paths: ["README.md", "server/src/routes/issues.ts"],
  });
  assert.equal(result.mode, "selective");
  assert.equal(result.run_core, true);
  assert.equal(result.run_server, true);
  assert.equal(result.run_workspaces, false);
});

test("workflow changes are high-risk even on draft docs companions", () => {
  const result = classifyPrCi({
    draft: true,
    paths: ["doc/GOAL.md", ".github/workflows/pr.yml"],
  });
  assert.equal(result.mode, "full");
  assert.ok(result.high_risk.some((hit) => hit.startsWith("workflows:")));
});

test("high-risk draft forces full even for otherwise selective paths", () => {
  const result = classifyPrCi({
    draft: true,
    paths: ["ui/src/pages/board.tsx", "packages/db/src/schema/issues.ts"],
  });
  assert.equal(result.mode, "full");
  assert.ok(result.high_risk.some((hit) => hit.includes("migrations-db")));
});

test("ci:full label forces full even for docs-only drafts", () => {
  const result = classifyPrCi({
    draft: true,
    labels: [FULL_LABEL],
    paths: ["doc/GOAL.md"],
  });
  assert.equal(result.mode, "full");
  assert.equal(result.run_e2e, true);
  assert.equal(result.run_server, true);
  assert.match(result.reason, /ci:full/);
});

test("toGithubOutputs emits 0/1 flags including server and workspaces lanes", () => {
  const docs = classifyPrCi({ draft: true, paths: ["README.md"] });
  const outputs = toGithubOutputs(docs);
  assert.equal(outputs.run_core, "0");
  assert.equal(outputs.run_server, "0");
  assert.equal(outputs.run_workspaces, "0");
  assert.equal(outputs.run_ui, "0");
  assert.equal(outputs.run_packages, "0");
  assert.equal(outputs.run_cli, "0");
  assert.equal(outputs.run_e2e, "0");
  const matrix = JSON.parse(outputs.e2e_matrix);
  assert.equal(matrix.length, 1);
  assert.equal(matrix[0].skip, true);

  const full = toGithubOutputs(classifyPrCi({ draft: false, paths: ["server/x.ts"] }));
  assert.equal(full.run_core, "1");
  assert.equal(full.run_server, "1");
  assert.equal(full.run_workspaces, "1");
  assert.equal(full.run_ui, "1");
  assert.equal(JSON.parse(full.e2e_matrix).length, 2);

  const server = toGithubOutputs(
    classifyPrCi({ draft: true, paths: ["server/src/routes/issues.ts"] }),
  );
  assert.equal(server.run_core, "1");
  assert.equal(server.run_server, "1");
  assert.equal(server.run_workspaces, "0");
  assert.equal(server.run_ui, "0");
  assert.equal(server.run_packages, "0");
  assert.equal(server.run_cli, "0");
});

test("checkServerLaneFlags and checkWorkspacesLaneFlags are fail-closed", () => {
  assert.deepEqual(WORKSPACES_SUB_LANE_FLAGS, ["run_ui", "run_packages", "run_cli"]);

  assert.equal(
    checkServerLaneFlags({ mode: "selective", run_server: "1" }).ok,
    true,
  );
  assert.equal(
    checkServerLaneFlags({ mode: "full", run_server: "1" }).ok,
    true,
  );
  assert.equal(
    checkServerLaneFlags({ mode: "selective", run_server: "0" }).ok,
    false,
  );
  assert.equal(
    checkServerLaneFlags({ mode: "selective", run_server: "" }).ok,
    false,
  );

  assert.equal(
    checkWorkspacesLaneFlags({
      mode: "selective",
      run_ui: "1",
      run_packages: "0",
      run_cli: "0",
    }).ok,
    true,
  );
  assert.equal(
    checkWorkspacesLaneFlags({
      mode: "full",
      run_ui: "1",
      run_packages: "1",
      run_cli: "1",
    }).ok,
    true,
  );
  assert.equal(
    checkWorkspacesLaneFlags({
      mode: "selective",
      run_ui: "0",
      run_packages: "0",
      run_cli: "0",
    }).ok,
    false,
  );
  assert.equal(
    checkWorkspacesLaneFlags({
      mode: "selective",
      run_ui: "",
      run_packages: "0",
      run_cli: "0",
    }).ok,
    false,
  );
  assert.equal(
    checkWorkspacesLaneFlags({
      mode: "full",
      run_ui: "1",
      run_packages: "0",
      run_cli: "1",
    }).ok,
    false,
  );
});

test("checkCoreLaneFlags is fail-closed on empty/invalid selective flags", () => {
  assert.deepEqual(CORE_SUB_LANE_FLAGS, ["run_server", "run_ui", "run_packages", "run_cli"]);

  assert.equal(
    checkCoreLaneFlags({
      mode: "selective",
      run_server: "1",
      run_ui: "0",
      run_packages: "0",
      run_cli: "0",
    }).ok,
    true,
  );
  assert.equal(
    checkCoreLaneFlags({
      mode: "full",
      run_server: "1",
      run_ui: "1",
      run_packages: "1",
      run_cli: "1",
    }).ok,
    true,
  );
  assert.equal(
    checkCoreLaneFlags({
      mode: "selective",
      run_server: "",
      run_ui: "0",
      run_packages: "0",
      run_cli: "0",
    }).ok,
    false,
  );
  assert.equal(
    checkCoreLaneFlags({
      mode: "selective",
      run_server: "0",
      run_ui: "0",
      run_packages: "0",
      run_cli: "0",
    }).ok,
    false,
  );
  assert.equal(
    checkCoreLaneFlags({
      mode: "full",
      run_server: "1",
      run_ui: "1",
      run_packages: "0",
      run_cli: "1",
    }).ok,
    false,
  );
});

test("parseRunFlag and checkLaneAggregate are fail-closed on empty/invalid flags", () => {
  assert.equal(parseRunFlag("1"), true);
  assert.equal(parseRunFlag("0"), false);
  assert.equal(parseRunFlag(true), true);
  assert.equal(parseRunFlag(false), false);
  assert.equal(parseRunFlag("true"), true);
  assert.equal(parseRunFlag("false"), false);
  assert.equal(parseRunFlag(""), null);
  assert.equal(parseRunFlag(undefined), null);
  assert.equal(parseRunFlag("yes"), null);
  assert.equal(parseRunFlag("2"), null);

  // Empty outputs (missing --github-output) must not look like intentional off.
  assert.equal(checkLaneAggregate({ run: "", result: "skipped" }).ok, false);
  assert.equal(checkLaneAggregate({ run: undefined, result: "skipped" }).ok, false);
  assert.equal(checkLaneAggregate({ run: "maybe", result: "success" }).ok, false);
  assert.equal(checkLaneAggregate({ run: false, result: "skipped" }).ok, true);
  assert.equal(checkLaneAggregate({ run: "false", result: "skipped" }).ok, true);
});

test("checkLaneAggregate accepts skipped when lane is off", () => {
  assert.equal(checkLaneAggregate({ run: "0", result: "skipped" }).ok, true);
  assert.equal(checkLaneAggregate({ run: "0", result: "success" }).ok, true);
  assert.equal(checkLaneAggregate({ run: "0", result: "failure" }).ok, false);
  assert.equal(checkLaneAggregate({ run: "0", result: "cancelled" }).ok, false);
  assert.equal(checkLaneAggregate({ run: "1", result: "skipped" }).ok, false);
  assert.equal(checkLaneAggregate({ run: "1", result: "success" }).ok, true);
});

test("checkVerifyAggregate gates server general/serialized and workspaces lanes independently", () => {
  const ok = checkVerifyAggregate({
    run_server: "0",
    run_workspaces: "0",
    run_build: "0",
    run_e2e: "0",
    server_general_result: "skipped",
    server_serialized_result: "skipped",
    workspaces_result: "skipped",
    build_result: "skipped",
    e2e_result: "skipped",
  });
  assert.equal(ok.ok, true);

  const failServerGeneral = checkVerifyAggregate({
    run_server: "1",
    run_workspaces: "0",
    run_build: "0",
    run_e2e: "0",
    server_general_result: "failure",
    server_serialized_result: "success",
    workspaces_result: "skipped",
    build_result: "skipped",
    e2e_result: "skipped",
  });
  assert.equal(failServerGeneral.ok, false);
  assert.deepEqual(failServerGeneral.failed, ["server_general"]);

  const failServerSerializedSkipped = checkVerifyAggregate({
    run_server: "1",
    run_workspaces: "0",
    run_build: "0",
    run_e2e: "0",
    server_general_result: "success",
    server_serialized_result: "skipped",
    workspaces_result: "skipped",
    build_result: "skipped",
    e2e_result: "skipped",
  });
  assert.equal(failServerSerializedSkipped.ok, false);
  assert.deepEqual(failServerSerializedSkipped.failed, ["server_serialized"]);

  const failBothWhenOffButCancelled = checkVerifyAggregate({
    run_server: "0",
    run_workspaces: "0",
    run_build: "0",
    run_e2e: "0",
    server_general_result: "cancelled",
    server_serialized_result: "skipped",
    workspaces_result: "skipped",
    build_result: "skipped",
    e2e_result: "skipped",
  });
  assert.equal(failBothWhenOffButCancelled.ok, false);
  assert.deepEqual(failBothWhenOffButCancelled.failed, ["server_general"]);

  const failWorkspacesSkipped = checkVerifyAggregate({
    run_server: "0",
    run_workspaces: "1",
    run_build: "0",
    run_e2e: "0",
    server_general_result: "skipped",
    server_serialized_result: "skipped",
    workspaces_result: "skipped",
    build_result: "skipped",
    e2e_result: "skipped",
  });
  assert.equal(failWorkspacesSkipped.ok, false);
  assert.deepEqual(failWorkspacesSkipped.failed, ["workspaces"]);

  const emptyFlags = checkVerifyAggregate({
    run_server: "",
    run_workspaces: "",
    run_build: "",
    run_e2e: "",
    server_general_result: "skipped",
    server_serialized_result: "skipped",
    workspaces_result: "skipped",
    build_result: "skipped",
    e2e_result: "skipped",
  });
  assert.equal(emptyFlags.ok, false);
  assert.deepEqual(emptyFlags.failed, [
    "server_general",
    "server_serialized",
    "workspaces",
    "build",
    "e2e",
  ]);
});

test("CLI classify writes GitHub outputs and explains the track", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "classify-pr-ci-"));
  const outFile = path.join(dir, "github_output");
  try {
    const result = spawnSync(
      process.execPath,
      [
        script,
        "classify",
        "--draft",
        "true",
        "--path",
        "server/src/routes/issues.ts",
        "--github-output",
        outFile,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CI track: selective/);
    assert.match(result.stdout, /Reason:/);
    const output = readFileSync(outFile, "utf8");
    assert.match(output, /^mode=selective$/m);
    assert.match(output, /^run_core=1$/m);
    assert.match(output, /^run_server=1$/m);
    assert.match(output, /^run_workspaces=0$/m);
    assert.match(output, /^run_ui=0$/m);
    assert.match(output, /^run_packages=0$/m);
    assert.match(output, /^run_cli=0$/m);
    assert.match(output, /^run_e2e=0$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI check-server-lanes and check-workspaces-lanes exit codes match fail-closed rules", () => {
  const serverPass = spawnSync(
    process.execPath,
    [script, "check-server-lanes", "--mode", "selective", "--run-server", "1"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(serverPass.status, 0, serverPass.stderr);

  const serverEmpty = spawnSync(
    process.execPath,
    [script, "check-server-lanes", "--mode", "selective", "--run-server", ""],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(serverEmpty.status, 0, "empty server flag must fail closed");

  const workspacesPass = spawnSync(
    process.execPath,
    [
      script,
      "check-workspaces-lanes",
      "--mode",
      "selective",
      "--run-ui",
      "1",
      "--run-packages",
      "0",
      "--run-cli",
      "0",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(workspacesPass.status, 0, workspacesPass.stderr);

  const workspacesAllOff = spawnSync(
    process.execPath,
    [
      script,
      "check-workspaces-lanes",
      "--mode",
      "selective",
      "--run-ui",
      "0",
      "--run-packages",
      "0",
      "--run-cli",
      "0",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(workspacesAllOff.status, 0, "selective workspaces with all sub-lanes off must fail");
});

test("CLI check-verify and check-e2e exit codes match aggregate rules", () => {
  const pass = spawnSync(
    process.execPath,
    [
      script,
      "check-verify",
      "--run-server",
      "0",
      "--run-workspaces",
      "0",
      "--run-build",
      "0",
      "--run-e2e",
      "0",
      "--server-general-result",
      "skipped",
      "--server-serialized-result",
      "skipped",
      "--workspaces-result",
      "skipped",
      "--build-result",
      "skipped",
      "--e2e-result",
      "skipped",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(pass.status, 0, pass.stderr);

  const fail = spawnSync(
    process.execPath,
    [script, "check-e2e", "--run-e2e", "1", "--result", "skipped"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(fail.status, 0);

  const emptyFlag = spawnSync(
    process.execPath,
    [script, "check-e2e", "--run-e2e", "", "--result", "skipped"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(emptyFlag.status, 0, "empty run flag must fail closed");
});
