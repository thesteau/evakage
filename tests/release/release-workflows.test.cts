// Adapted from thesteau/3to1go (MIT); executes workflow scripts with mocked APIs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const appRequire = require("node:module").createRequire(resolve(__dirname, "../../app/package.json"));
// Use the YAML parser already required by Release Please.
const { parse } = appRequire("yaml");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const workflowDirectory = resolve(__dirname, "..", "..", ".github/workflows");

function scripts(name: string): string[] {
  const source = readFileSync(resolve(workflowDirectory, `${name}.yml`), "utf8");
  return [...source.matchAll(/script: \|\r?\n((?: {12}[^\r\n]*(?:\r?\n|$))*)/g)].map((match: any) =>
    match[1].replace(/^ {12}/gm, ""),
  );
}

const repo = { owner: "example", repo: "backup" };

test("main pushes have one validation/publishing pipeline and promotion PRs cannot trigger images", () => {
  const workflows = ["ci", "image-latest"].map((name) => ({
    file: name,
    ...parse(readFileSync(resolve(workflowDirectory, `${name}.yml`), "utf8")),
  }));
  for (const [event, branch, expected] of [
    ["push", "main", ["image-latest"]],
    ["push", "prod", ["ci"]],
    ["pull_request", "main", ["ci"]],
    // For promotion PRs the source is main, but GitHub filters on base prod.
    ["pull_request", "prod", ["ci"]],
    ["workflow_run", "main", []],
  ]) {
    const triggered = workflows
      .filter((workflow) => workflow.on[event as string]?.branches?.includes(branch))
      .map((workflow) => workflow.file);
    assert.deepEqual(triggered, expected, `${event} on ${branch}`);
  }
});

test("main image publishing skips superseded commits and stops on lookup failures", async () => {
  const run = new AsyncFunction("github", "context", "core", scripts("image-latest")[0]);
  for (const tip of ["tested-main", "newer-main"]) {
    const outputs: any[] = [];
    await run(
      { rest: { git: { getRef: async (args: any) => {
        assert.deepEqual(args, { ...repo, ref: "heads/main" });
        return { data: { object: { sha: tip } } };
      } } } },
      { repo, sha: "tested-main" },
      { setOutput: (...args: any[]) => outputs.push(args) },
    );
    assert.deepEqual(outputs, [["publish", tip === "tested-main" ? "true" : "false"]]);
  }
  await assert.rejects(run(
    { rest: { git: { getRef: async () => { throw new Error("Lookup failed"); } } } },
    { repo, sha: "tested-main" },
    { setOutput: () => assert.fail("Lookup failure must not authorize publishing") },
  ), /Lookup failed/);
});

test("release automation dispatches metadata validation and images using trusted prod workflows", async () => {
  for (const operation of ["plan", "publish"]) {
    const calls: any[] = [];
    const github = {
      rest: {
        repos: {
          getContent: async (args: any) => {
            assert.equal(args.ref, "approved-merge-sha");
            return { data: { content: Buffer.from('{"tag":"v1.2.3"}').toString("base64") } };
          },
        },
        pulls: {
          list: async (args: any) => {
            assert.equal(args.base, "release-state");
            assert.equal(args.head, "example:release-please--branches--release-state");
            return { data: [{ number: 42 }] };
          },
        },
        actions: { createWorkflowDispatch: async (args: any) => calls.push(args) },
      },
    };
    const releaseScripts = scripts("release-please");
    if (operation === "publish") {
      await new AsyncFunction("github", "context", "process", "Buffer", releaseScripts[0])(
        github,
        { repo },
        { env: { RELEASE_STATE_REF: "approved-merge-sha" } },
        Buffer,
      );
    }
    await new AsyncFunction("github", "context", releaseScripts[1])(github, { repo });
    assert.deepEqual(calls, [
      ...(operation === "publish"
        ? [{ ...repo, workflow_id: "stable-docker-images.yml", ref: "prod", inputs: { tag: "v1.2.3" } }]
        : []),
      { ...repo, workflow_id: "release-state-check.yml", ref: "prod", inputs: { pr: "42" } },
    ]);
  }
});

test("a failed next proposal cannot prevent dispatch of already-published release images", async () => {
  const source = readFileSync(resolve(workflowDirectory, "release-please.yml"), "utf8");
  const steps = source.split(/^ {6}- /m).slice(1);
  const calls: string[] = [];
  const github = {
    rest: {
      repos: { getContent: async () => ({ data: { content: Buffer.from('{"tag":"v1.2.3"}').toString("base64") } }) },
      actions: { createWorkflowDispatch: async (args: any) => calls.push(args.inputs.tag) },
    },
  };
  // Execute the publication-related steps in workflow order. The next proposal
  // fails, as it would if GitHub rejected its PR creation after publication.
  await assert.rejects(async () => {
    for (const step of steps) {
      if (step.startsWith("name: Plan or publish the recorded production commit")) calls.push("published");
      if (step.startsWith("name: Start stable image publishing")) {
        await new AsyncFunction("github", "context", "process", "Buffer", scripts("release-please")[0])(
          github,
          { repo },
          { env: { RELEASE_STATE_REF: "approved-merge-sha" } },
          Buffer,
        );
      }
      if (step.startsWith("name: Plan next release after publication")) {
        calls.push("planning");
        throw new Error("Next proposal PR creation failed");
      }
    }
  }, /Next proposal PR creation failed/);
  assert.deepEqual(calls, ["published", "v1.2.3", "planning"]);
});

test("metadata dispatch resolves only open same-repository automation PRs into release-state", async () => {
  const valid = {
    state: "open",
    base: { ref: "release-state" },
    head: {
      sha: "metadata-head",
      ref: "release-please--branches--release-state",
      repo: { full_name: "example/backup" },
    },
  };
  const run = new AsyncFunction("github", "context", "process", "core", scripts("release-state-check")[0]);
  for (const pr of [
    valid,
    { ...valid, state: "closed" },
    { ...valid, base: { ref: "prod" } },
    { ...valid, head: { ...valid.head, ref: "main" } },
    { ...valid, head: { ...valid.head, repo: { full_name: "fork/backup" } } },
  ]) {
    const outputs: any[] = [];
    const invoke = () =>
      run(
        {
          rest: {
            pulls: {
              get: async (args: any) => {
                assert.equal(args.pull_number, 42);
                return { data: pr };
              },
            },
          },
        },
        { repo },
        { env: { PR_NUMBER: "42" } },
        { setOutput: (...args: any[]) => outputs.push(args) },
      );
    if (pr === valid) {
      await invoke();
      assert.deepEqual(outputs, [["sha", "metadata-head"]]);
    } else {
      await assert.rejects(invoke(), /Expected an open same-repository/);
      assert.deepEqual(outputs, []);
    }
  }
});

test("PR titles must be Conventional Commits and report their release effect", async () => {
  const run = new AsyncFunction("core", "process", scripts("pr-title")[0]);
  for (const [title, expected] of [
    ["feat: add restore preview", 'notice:"feat" title: minor release once promoted to prod.'],
    ["fix(relay): retry uploads", 'notice:"fix" title: patch release once promoted to prod.'],
    ["perf: faster scans", 'notice:"perf" title: patch release once promoted to prod.'],
    ["feat(server)!: drop legacy API", 'notice:"feat!" title: major release once promoted to prod.'],
    ["chore!: remove old config keys", 'notice:"chore!" title: major release once promoted to prod.'],
    ["docs: explain retention", 'notice:"docs" title: no release on its own once promoted to prod.'],
    ["Add fading", "failed"],
    ["feat:missing space", "failed"],
    ["Feat: capitalised", "failed"],
    ["feature: unknown type", "failed"],
    ["constructor: inherited key", "failed"],
    ["fix(Scout): uppercase scope", "failed"],
    ["fix: ", "failed"],
  ]) {
    const calls: string[] = [];
    await run(
      { notice: (text: string) => calls.push(`notice:${text}`), setFailed: () => calls.push("failed") },
      { env: { PR_TITLE: title } },
    );
    assert.deepEqual(calls, [expected], title);
  }
});

test("metadata status reports pending and validation outcomes on the resolved PR head", async () => {
  const workflowScripts = scripts("release-state-check");
  for (const [index, result, expected] of [
    [1, "success", "pending"],
    [2, "success", "success"],
    [2, "failure", "failure"],
    [2, "cancelled", "failure"],
  ]) {
    const calls: any[] = [];
    await new AsyncFunction("github", "context", "process", workflowScripts[index as number])(
      { rest: { repos: { createCommitStatus: async (args: any) => calls.push(args) } } },
      { repo, sha: "base-commit", serverUrl: "https://github.com", runId: 12 },
      { env: { PR_HEAD_SHA: "metadata-head", VALIDATION_RESULT: result } },
    );
    assert.deepEqual(calls, [
      {
        ...repo,
        sha: "metadata-head",
        context: "Validate release metadata",
        state: expected,
        target_url: "https://github.com/example/backup/actions/runs/12",
      },
    ]);
  }
});
