// Adapted from thesteau/3to1go (MIT); exercises the actual Release Please strategy.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, dirname, basename } = require("node:path");
const bridge = require("../../scripts/release-state.cts");

const initial = {
  version: "1.0.0",
  tag: "v1.0.0",
  prodSha: "a".repeat(40),
  previousTag: null,
  previousSha: null,
  notes: "First release",
};
const files = [".release-please-manifest.json", "CHANGELOG.md", "release.json"];
const tree = files.map((path) => ({ path, mode: "100644", type: "blob" }));

test("release state requires a stable increasing version and exact SHA", () => {
  bridge.validateState(initial);
  bridge.validateState({
    ...initial,
    version: "1.1.0",
    tag: "v1.1.0",
    previousTag: "v1.0.0",
    previousSha: "b".repeat(40),
  });
  for (const invalid of [
    { ...initial, tag: "v2.0.0" },
    { ...initial, prodSha: "main" },
    { ...initial, version: "1.0.0-rc.1", tag: "v1.0.0-rc.1" },
    { ...initial, version: "2.0.0", tag: "v2.0.0" },
    { ...initial, previousTag: "v1.0.0" },
    { ...initial, previousTag: "v1.1.0", previousSha: "b".repeat(40) },
  ])
    assert.throws(() => bridge.validateState(invalid));
});

test("metadata branch rejects application files, symlinks, and directories", () => {
  bridge.validateTree(tree);
  assert.throws(() => bridge.validateTree([...tree, { path: "app.go", mode: "100644", type: "blob" }]));
  assert.throws(() => bridge.validateTree(tree.map((entry) => ({ ...entry, mode: "120000" }))));
  assert.throws(() => bridge.validateTree(tree.slice(1)));
  assert.throws(() => bridge.validateTree([tree[0], tree[0], tree[2]]));
});

test("bootstrap creates only metadata in an orphan commit and is idempotent", async () => {
  const calls: any[] = [];
  let exists = false;
  const api = {
    git: {
      getRef: async () => {
        if (!exists) throw { status: 404 };
        return { data: { object: { sha: "state" } } };
      },
      createTree: async (args: any) => {
        calls.push(args);
        return { data: { sha: "tree" } };
      },
      createCommit: async (args: any) => {
        calls.push(args);
        return { data: { sha: "state" } };
      },
      createRef: async (args: any) => {
        calls.push(args);
        exists = true;
      },
    },
  };
  await bridge.bootstrap(api, {});
  assert.deepEqual(calls[0].tree.map((entry: any) => entry.path).sort(), [...files].sort());
  assert.deepEqual(calls[1].parents, []);
  assert.equal(calls[2].ref, "refs/heads/release-state");
  await bridge.bootstrap(api, {});
  assert.equal(calls.length, 3);
});

test("publication refuses an existing version tag at another commit", async () => {
  const api = {
    repos: {
      getReleaseByTag: async () => {
        throw { status: 404 };
      },
    },
    git: { getRef: async () => ({ data: { object: { type: "commit", sha: "b".repeat(40) } } }) },
  };
  await assert.rejects(bridge.published(api, {}, initial), /different commit/);
  api.git.getRef = async () => ({ data: { object: { type: "commit", sha: initial.prodSha } } });
  assert.equal(await bridge.published(api, {}, initial), false);
});

test("metadata manifest must agree with the approved version", async () => {
  const content: Record<string, string> = {
    "release.json": JSON.stringify(initial),
    ".release-please-manifest.json": '{".":"1.1.0"}',
    "CHANGELOG.md": "# 1.0.0",
  };
  const api = {
    git: { getTree: async () => ({ data: { tree } }) },
    repos: {
      getContent: async ({ path }: any) => ({
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(content[path]).toString("base64"),
        },
      }),
    },
  };
  await assert.rejects(bridge.readState(api, {}, "state"), /Manifest mismatch/);
  content[".release-please-manifest.json"] = '{".":"1.0.0"}';
  assert.deepEqual(await bridge.readState(api, {}, "state"), initial);
});

test("planning after prod is reset counts only what the last release did not ship", (context: any) => {
  const folder = mkdtempSync(join(tmpdir(), "evakage-release-"));
  const oldCwd = process.cwd();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => warnings.push(message));
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Release validation");
    git("config", "user.email", "validation@example.invalid");
    writeFileSync(join(folder, "app.txt"), "first");
    git("add", ".");
    git("commit", "-m", "feat: initial application");
    // Promote main with a merge commit and release that commit.
    git("checkout", "-b", "prod");
    git("commit", "--allow-empty", "-m", "chore: prod-only setup");
    git("merge", "--no-ff", "main", "-m", "chore: promote main to prod");
    const released = git("rev-parse", "HEAD");
    // More work lands on main, then prod is reset to main, dropping the release commit.
    git("checkout", "main");
    git("commit", "--allow-empty", "-m", "fix: later change");
    git("commit", "--allow-empty", "-m", "docs: later docs");
    git("branch", "-f", "prod", "main");
    git("update-ref", "refs/remotes/origin/prod", git("rev-parse", "prod"));
    process.chdir(folder);

    const commits = bridge.commitsBetween(git("rev-parse", "prod"), released);
    assert.deepEqual(
      commits.map((c: any) => c.message),
      ["docs: later docs", "fix: later change"],
      "the already-released feature is not counted again",
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /isn't in prod's history/);

    // A commit that isn't on prod still can't be released.
    assert.throws(() => bridge.commitsBetween(released, null), /is not on prod/);
  } finally {
    process.chdir(oldCwd);
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a promotion releases main's commit unless prod changed the files", () => {
  const folder = mkdtempSync(join(tmpdir(), "evakage-release-"));
  const oldCwd = process.cwd();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Release validation");
    git("config", "user.email", "validation@example.invalid");
    writeFileSync(join(folder, "app.txt"), "first");
    git("add", ".");
    git("commit", "-m", "feat: initial application");
    git("branch", "prod");
    process.chdir(folder);

    // A plain commit on prod is released as is.
    assert.equal(bridge.releaseCommit(git("rev-parse", "prod")), git("rev-parse", "prod"));

    // A promotion merge with main's files releases main's commit.
    git("commit", "--allow-empty", "-m", "fix: on main");
    git("checkout", "prod");
    git("merge", "--no-ff", "main", "-m", "chore: promote main to prod");
    assert.equal(bridge.releaseCommit(git("rev-parse", "prod")), git("rev-parse", "main"));

    // A merge whose files differ from main's keeps the merge commit.
    writeFileSync(join(folder, "prod.txt"), "prod only");
    git("add", "prod.txt");
    git("commit", "-m", "chore: prod-only file");
    git("checkout", "main");
    git("commit", "--allow-empty", "-m", "fix: another");
    git("checkout", "prod");
    git("merge", "--no-ff", "main", "-m", "chore: promote main to prod");
    assert.equal(bridge.releaseCommit(git("rev-parse", "prod")), git("rev-parse", "prod"));
  } finally {
    process.chdir(oldCwd);
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a prod-only feature released earlier is not counted again after a release tags main", () => {
  const folder = mkdtempSync(join(tmpdir(), "evakage-release-"));
  const oldCwd = process.cwd();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const promote = () => {
    git("checkout", "prod");
    git("merge", "--no-ff", "main", "-m", "chore: promote main to prod");
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Release validation");
    git("config", "user.email", "validation@example.invalid");
    writeFileSync(join(folder, "app.txt"), "first");
    git("add", ".");
    git("commit", "-m", "feat: initial application");
    git("branch", "prod");
    process.chdir(folder);

    // v1.0.0 ships a feature that only exists on prod.
    git("checkout", "prod");
    writeFileSync(join(folder, "prod.txt"), "prod only");
    git("add", "prod.txt");
    git("commit", "-m", "feat: prod-only feature");
    git("tag", "v1.0.0");
    // prod drops it again, so the next promotion matches main and v1.0.1 tags main's commit.
    git("rm", "-q", "prod.txt");
    git("commit", "-m", "chore: drop prod-only file");
    git("checkout", "main");
    git("commit", "--allow-empty", "-m", "fix: on main");
    promote();
    const second = bridge.releaseCommit(git("rev-parse", "prod"));
    assert.equal(second, git("rev-parse", "main"));
    git("tag", "-a", "v1.0.1", "-m", "v1.0.1", second);
    // The next release keeps prod's tip, whose history still has the feature.
    git("checkout", "prod");
    writeFileSync(join(folder, "prod.txt"), "prod fix");
    git("add", "prod.txt");
    git("commit", "-m", "fix: prod-only fix");
    git("checkout", "main");
    git("commit", "--allow-empty", "-m", "fix: another");
    promote();
    git("update-ref", "refs/remotes/origin/prod", git("rev-parse", "prod"));
    const tip = bridge.releaseCommit(git("rev-parse", "prod"));
    assert.equal(tip, git("rev-parse", "prod"));

    const released = bridge.releasedCommits("1.0.1");
    assert.deepEqual(released.sort(), [git("rev-parse", "v1.0.0"), second].sort(), "annotated tags resolve to commits");
    assert.deepEqual(bridge.releasedCommits("1.0.0"), [git("rev-parse", "v1.0.0")], "later tags are not excluded");
    const onlyPrevious = bridge.commitsBetween(tip, second).map((c: any) => c.message);
    assert.ok(onlyPrevious.includes("feat: prod-only feature"), "the previous release alone would miss it");
    const messages = bridge.commitsBetween(tip, second, released).map((c: any) => c.message);
    assert.ok(!messages.includes("feat: prod-only feature"), "the feature v1.0.0 shipped is not counted again");
    assert.ok(messages.includes("fix: prod-only fix") && messages.includes("fix: another"));
  } finally {
    process.chdir(oldCwd);
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    rmSync(folder, { recursive: true, force: true });
  }
});

test("real Release Please handles repeated promotions without release metadata on code branches", async (context: any) => {
  const folder = mkdtempSync(join(tmpdir(), "evakage-release-"));
  const oldCwd = process.cwd();
  const config = resolve(oldCwd, "release-please-config.json");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const github = { repository: { owner: "example", repo: "backup", defaultBranch: "prod" } };
  let approved: any = null;
  let proposed: any = null;
  const tags: Record<string, string> = {};
  const releases: Record<string, any> = {};
  const api = {
    git: {
      getRef: async ({ ref }: any) => {
        if (ref === "heads/release-state") return { data: { object: { sha: "state" } } };
        const sha = tags[ref.replace("tags/", "")];
        if (!sha) throw { status: 404 };
        return { data: { object: { type: "commit", sha } } };
      },
      getTree: async () => ({ data: { tree } }),
      createRef: async ({ ref, sha }: any) => {
        tags[ref.replace("refs/tags/", "")] = sha;
      },
    },
    repos: {
      getContent: async ({ path }: any) => ({
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(
            path === "release.json"
              ? JSON.stringify(approved)
              : path === ".release-please-manifest.json"
                ? JSON.stringify(approved ? { ".": approved.version } : {})
                : `# Changelog\n${approved?.version ?? ""}`,
          ).toString("base64"),
        },
      }),
      getReleaseByTag: async ({ tag }: any) => {
        if (!releases[tag]) throw { status: 404 };
        return { data: releases[tag] };
      },
    },
  };
  const client = {
    ...github,
    createPullRequest: async (pr: any, base: string, _message: string, updates: any[]) => {
      assert.equal(base, "release-state");
      assert.equal(pr.headBranchName, "release-please--branches--release-state");
      const update = updates.find((entry) => entry.path === "release.json");
      proposed = JSON.parse(update.updater.updateContent(""));
      const changelog = updates.find((entry) => entry.path === "CHANGELOG.md").updater.updateContent("# Changelog\n");
      assert.ok(changelog.includes(proposed.version));
    },
    createRelease: async (release: any) => {
      assert.equal(tags[release.tag.toString()], release.sha);
      releases[release.tag.toString()] = {
        body: release.notes,
        target_commitish: release.sha,
        draft: false,
        prerelease: false,
      };
    },
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Release validation");
    git("config", "user.email", "validation@example.invalid");
    writeFileSync(join(folder, "app.txt"), "first");
    git("add", ".");
    git("commit", "-m", "feat: initial application");
    git("branch", "prod");
    // Config is automation code, not per-release metadata.
    writeFileSync(join(folder, "release-please-config.json"), require("node:fs").readFileSync(config));
    process.chdir(folder);
    git("update-ref", "refs/remotes/origin/prod", git("rev-parse", "prod"));
    await bridge.plan(client, api, {});
    assert.equal(proposed.version, "1.0.0");
    approved = proposed;
    git("checkout", "main");
    writeFileSync(join(folder, "app.txt"), "documentation while approval is pending");
    git("add", "app.txt");
    git("commit", "-m", "fix: expand usage");
    git("checkout", "prod");
    git("merge", "--no-ff", "main", "-m", "chore: promote main to prod");
    git("update-ref", "refs/remotes/origin/prod", git("rev-parse", "prod"));
    assert.notEqual(approved.prodSha, git("rev-parse", "prod"));
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() + 86400000 });
    const createPullRequest = client.createPullRequest;
    client.createPullRequest = async () => {
      throw new Error("Next proposal PR creation failed");
    };
    // Publishing must complete independently of a failure in the next plan.
    await bridge.publish(client, api, {}, "state");
    await assert.rejects(bridge.plan(client, api, {}), /Next proposal PR creation failed/);
    client.createPullRequest = createPullRequest;
    assert.equal(tags["v1.0.0"], approved.prodSha); // The recorded SHA, not the later prod head.
    await bridge.publish(client, api, {}, "state"); // Retry does not move the tag or release.
    assert.equal(Object.keys(releases).length, 1);
    for (const [message, version] of [
      ["fix: repair backup", "1.0.1"],
      ["feat: another feature", "1.1.0"],
      ["feat!: breaking format change", "2.0.0"],
    ]) {
      git("checkout", "main");
      writeFileSync(join(folder, "app.txt"), message);
      git("add", "app.txt");
      git("commit", "-m", message);
      git("checkout", "prod");
      git("merge", "--no-ff", "main", "-m", "chore: promote main to prod");
      git("update-ref", "refs/remotes/origin/prod", git("rev-parse", "prod"));
      await bridge.plan(client, api, {});
      assert.equal(proposed.version, version);
      assert.equal(proposed.prodSha, git("rev-parse", "prod^2"), "releases the promoted main commit");
      approved = proposed;
      await bridge.publish(client, api, {}, "state");
    }
    git("checkout", "main");
    writeFileSync(join(folder, "app.txt"), "docs only");
    git("add", "app.txt");
    git("commit", "-m", "docs: explain deployments");
    git("checkout", "prod");
    git("merge", "--no-ff", "main", "-m", "chore: promote main to prod");
    git("update-ref", "refs/remotes/origin/prod", git("rev-parse", "prod"));
    assert.equal(await bridge.buildCandidate(github, git("rev-parse", "prod"), approved), undefined);
    assert.equal(git("ls-tree", "--name-only", "prod"), "app.txt");
    assert.equal(git("ls-tree", "--name-only", "main"), "app.txt");
    assert.equal(Object.keys(releases).length, 4);
    // A wrong or non-production SHA cannot be released.
    await assert.rejects(bridge.buildCandidate(github, "b".repeat(40), approved));
  } finally {
    process.chdir(oldCwd);
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith("evakage-release-"));
    rmSync(folder, { recursive: true, force: true });
  }
});
