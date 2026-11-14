import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const tag = process.env.RELEASE_TAG;
assert(
  tag && /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag),
  "A precise existing SemVer tag is required",
);
assert.equal(
  process.env.GITHUB_REF,
  "refs/heads/main",
  "Dispatch from main only",
);
if (process.env.RELEASE_PUBLISH === "true")
  assert.equal(
    process.env.RELEASE_RIGHTS_CONFIRMED,
    "true",
    "Confirm scope ownership, name/trademark review and separate publication authorization first",
  );
const sha = execFileSync("git", ["rev-parse", `refs/tags/${tag}^{commit}`], {
  encoding: "utf8",
}).trim();
execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
assert.equal(
  `v${JSON.parse(execFileSync("git", ["show", `${sha}:packages/core/package.json`], { encoding: "utf8" })).version}`,
  tag,
  "Tag and package version differ",
);
const repository = process.env.GITHUB_REPOSITORY;
assert.equal(repository, "ysj101/jorney_gap");
const api = (path) =>
  JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/${path}`], {
      encoding: "utf8",
      maxBuffer: 8 * 1048576,
    }),
  );
const runs = api(
  `actions/runs?head_sha=${sha}&event=push&status=success&per_page=100`,
).workflow_runs;
const run = runs.find(
  (run) =>
    run.path === ".github/workflows/ci.yml" &&
    run.head_branch === "main" &&
    run.conclusion === "success",
);
assert(run, "Tag commit requires a successful main CI run");
const jobs = api(`actions/runs/${run.id}/jobs?per_page=100`).jobs;
for (const name of ["check", "containers", "security"])
  assert(
    jobs.some((job) => job.name === name && job.conclusion === "success"),
    `Required CI job missing or failed: ${name}`,
  );
const environment = api("environments/npm-release");
assert(
  environment.protection_rules.some(
    (rule) => rule.type === "required_reviewers" && rule.reviewers?.length,
  ),
  "Configure required human reviewers on npm-release before publishing",
);
assert.equal(
  environment.deployment_branch_policy?.custom_branch_policies,
  true,
  "Release environment branch restrictions must be enabled",
);
assert.equal(environment.deployment_branch_policy?.protected_branches, false);
const policies = api(
  "environments/npm-release/deployment-branch-policies",
).branch_policies;
assert(
  policies.some((policy) => policy.name === "main" && policy.type === "branch"),
  "Release environment must allow main only",
);
assert.equal(
  policies.length,
  1,
  "Unexpected release environment branch/tag allowance",
);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
console.log(
  `Validated ${tag} (${sha.slice(0, 12)}) with green main CI and a required reviewer. No publication performed.`,
);
