// `.github/workflows/publish-npm.yml` 的**发布政策**契约测试（issue #43 / 设计稿 §5.2、§6、§11）。
//
// m10：真正解析 workflow YAML（本地无 yaml 依赖，用 test/helpers/workflow-yaml.mjs 的
// 最小子集解析器 + 结构断言），并：
//   - 对每个 `run:` 块跑 `bash -n`；
//   - 对内联 `node -e` / `node --input-type=module -e` 跑 `node --check`；
//   - 拒绝同一 run 块内引用本块刚写入 $GITHUB_ENV 的键（B1 回归）。
//
// 判定逻辑本身由 release-policy / release-gate 测试覆盖；这里确保 workflow 按设计稿的
// 顺序与 fail-closed 语义编排。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	checkNodeSnippetsSyntax,
	checkRunBlocksBashSyntax,
	nodeSnippets,
	parseWorkflowFile,
	runBlocks,
	sameBlockEnvReferences,
	workflowSteps,
} from "./helpers/workflow-yaml.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_FILE = path.join(ROOT, ".github", "workflows", "publish-npm.yml");
const WORKFLOW_TEXT = fs.readFileSync(WORKFLOW_FILE, "utf8");
const WORKFLOW = parseWorkflowFile(WORKFLOW_FILE);
const STEPS = workflowSteps(WORKFLOW);
const BLOCKS = runBlocks(WORKFLOW);
const GATE = fs.readFileSync(path.join(ROOT, "tools", "release-gate.mjs"), "utf8");

function stepByName(name) {
	const step = STEPS.find((candidate) => candidate.name === name);
	assert.ok(step, `workflow 缺少步骤 ${name}`);
	return step;
}

function blockByName(name) {
	const block = BLOCKS.find((candidate) => candidate.name === name);
	assert.ok(block, `workflow 缺少 run 块 ${name}`);
	return block;
}

test("workflow: YAML parses and keeps required triggers/permissions/concurrency", () => {
	assert.equal(WORKFLOW.name, "Publish npm release");
	assert.deepEqual(WORKFLOW.on, { push: { tags: ["v*"] } });
	assert.deepEqual(WORKFLOW.permissions, { contents: "write", "id-token": "write" });
	assert.equal(WORKFLOW.concurrency.group, "npm-publish");
	assert.equal(WORKFLOW.concurrency["cancel-in-progress"], "false");
	assert.ok(STEPS.length >= 25, `步骤数量异常: ${STEPS.length}`);
	const names = STEPS.map((step) => step.name);
	assert.equal(new Set(names).size, names.length, "步骤名不得重复");
	for (const step of STEPS) assert.ok(step.name, "每个步骤必须有 name");
	assert.deepEqual(Object.keys(WORKFLOW.jobs ?? {}), ["publish"]);
});

test("workflow: B1 regression — no run block references GITHUB_ENV keys written in the same block", () => {
	for (const block of BLOCKS) {
		assert.deepEqual(
			sameBlockEnvReferences(block.run),
			[],
			`步骤「${block.name}」在同一 shell 里引用了本步骤写入 $GITHUB_ENV 的变量（GITHUB_ENV 只对后续步骤生效）`,
		);
	}
	// 检测器自检：合成坏块必须被拒绝。
	const broken = 'echo "STATE=fresh" >> "$GITHUB_ENV"\necho "$STATE"';
	assert.deepEqual(sameBlockEnvReferences(broken), ["STATE"]);

	// release-gate prepare 写入的键（B1 现场）：同一块里不得引用。
	const prepareBlock = blockByName("Decide publish state, build frontier, and dist-tag movements");
	const gateEnvKeys = [
		"TAG", "TAG_KIND", "PLUGIN_VERSION", "PLUGIN_TAG", "PLUGIN_PUBLISH_TAG", "PLUGIN_STAGING_TAG",
		"APP_VERSION", "BUILD", "CARRIER_VERSION", "STATE", "WATERMARK", "FRONTIER",
		"APP_CURRENT", "APP_DECISION", "LATEST_BEFORE", "LATEST_DECISION", "CHANNEL_CURRENT",
		"CHANNEL_DECISION", "LEFTOVER_INTENT_STATUS",
	];
	for (const key of gateEnvKeys) {
		assert.doesNotMatch(
			prepareBlock.run,
			new RegExp(`\\$\\{?${key}\\b`),
			`release-gate prepare 步骤不得在同类 shell 中引用 $${key}`,
		);
	}
	assert.doesNotMatch(prepareBlock.run, /echo "state=\$\{STATE\}/, "B1 的同类 shell echo 必须删除");
});

test("workflow: every run block passes bash -n; every inline node snippet passes node --check", () => {
	const bashFailures = checkRunBlocksBashSyntax(BLOCKS);
	assert.deepEqual(bashFailures, [], `bash -n 失败: ${JSON.stringify(bashFailures)}`);
	const nodeFailures = checkNodeSnippetsSyntax(BLOCKS);
	assert.deepEqual(nodeFailures, [], `node --check 失败: ${JSON.stringify(nodeFailures)}`);
	assert.ok(nodeSnippets(blockByName("Validate tag and version pairing").run).length > 0);
});

test("workflow: tag identity and ancestry — alpha reachable from origin/develop; rc/stable from release/v<core>", () => {
	const ancestry = blockByName("Enforce tag ancestry (alpha → develop, rc/stable → release/vX.Y.Z)").run;
	assert.match(ancestry, /merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/develop/);
	assert.match(ancestry, /branch="release\/v\$\{CORE_VERSION\}"/);
	assert.match(ancestry, /merge-base --is-ancestor "\$GITHUB_SHA" "refs\/remotes\/origin\/\$\{branch\}"/);
	assert.match(ancestry, /release-branch-core-mismatch/);
	assert.match(ancestry, /alpha tag reachability OK/);
	assert.doesNotMatch(WORKFLOW_TEXT, /branch -r --contains/, "不得用 contains 推断来源分支语义");

	// n5：PACKAGE_NAME 从 package.json 派生（不再硬编码在 workflow env）。
	assert.equal(WORKFLOW.env.PACKAGE_NAME, undefined, "PACKAGE_NAME 不得硬编码");
	const resolve = blockByName("Resolve release tag kind and version").run;
	assert.match(resolve, /readFileSync\("\.\/package\.json", "utf8"\)/);
	assert.match(resolve, /`PACKAGE_NAME=\$\{pkg\.name\}`/);
	assert.match(blockByName("Validate tag and version pairing").run, /exactCarrierAliasChecks/);
});

test("workflow: release-meta is the only authority; missing/diverged fails closed (m2 real second remote)", () => {
	const meta = blockByName("Fetch and validate release-meta authority").run;
	assert.match(meta, /git fetch origin '\+refs\/heads\/release-meta:refs\/remotes\/origin\/release-meta' --no-tags/);
	assert.match(meta, /git show refs\/remotes\/origin\/release-meta:build-policy\.json > "\$RUNNER_TEMP\/build-policy\.json"/);
	assert.match(meta, /release-meta-missing/);
	assert.match(meta, /release-meta-diverged/);
	assert.match(meta, /parseBuildPolicy/);
	assert.match(meta, /RELEASE_META_SOURCE=origin\/release-meta/);
	assert.doesNotMatch(WORKFLOW_TEXT, /cat\s+build-policy\.json/, "不得读取 tag 工作树内的副本");
	// m2：第二远端必须真正 git remote add + fetch；URL 来自 vars.*_URL。
	assert.match(meta, /git remote add "\$secondary" "\$RELEASE_META_SECONDARY_REMOTE_URL"/);
	assert.match(meta, /git fetch "\$secondary" "\+refs\/heads\/release-meta:refs\/remotes\/\$\{secondary\}\/release-meta"/);
	assert.match(meta, /cmp -s "\$RUNNER_TEMP\/build-policy\.json" "\$RUNNER_TEMP\/build-policy\.secondary\.json"/);
	assert.match(WORKFLOW_TEXT, /vars\.RELEASE_META_SECONDARY_REMOTE_URL/);
	assert.doesNotMatch(WORKFLOW_TEXT, /vars\.RELEASE_META_SECONDARY_REMOTE\s+\}\}/, "不得保留无实现的 remote 名变量");
});

test("workflow: publish state decided before dynamic channel guards; fully-published rerun is read-only", () => {
	const prepare = stepByName("Decide publish state, build frontier, and dist-tag movements");
	assert.match(prepare.run, /node tools\/release-gate\.mjs prepare/);
	assert.match(prepare.run, /--github-env "\$GITHUB_ENV"/);
	assert.equal(stepByName("Fully-published rerun read-only verification").if, "${{ env.STATE == 'fully-published' }}");
	const readonlyRun = blockByName("Fully-published rerun read-only verification").run;
	assert.match(readonlyRun, /verify-readonly/);
	assert.match(readonlyRun, /no publish, no dist-tag changes/);
	const readonlyIndex = STEPS.indexOf(stepByName("Fully-published rerun read-only verification"));
	const buildIndex = STEPS.indexOf(stepByName("Build signed Android APK"));
	assert.ok(readonlyIndex < buildIndex, "只读成功路径必须先于重构建步骤");

	const publishSteps = [
		"Publish carrier",
		"Publish plugin",
		"Set and verify channel / app / latest dist-tags",
		"Record release intent (submitted) in release-meta",
		"Assert BUILD matches packaged manifest and carrier",
		"Verify published tarball integrity",
		"Mark release intent published",
	];
	for (const name of publishSteps) {
		assert.equal(stepByName(name).if, "${{ env.STATE != 'fully-published' }}", `${name} 必须跳过 fully-published 重跑`);
	}
	assert.doesNotMatch(WORKFLOW_TEXT, /ALL_TAG_MAX|all-tag max|tag max/i, "不得使用全量 tag 最大值作 CI 判据");
});

test("workflow: build frontier comes from release-gate (never full tag max)", () => {
	const prepareIndex = STEPS.indexOf(stepByName("Decide publish state, build frontier, and dist-tag movements"));
	const publishIndex = STEPS.indexOf(stepByName("Publish carrier"));
	assert.ok(prepareIndex < publishIndex, "build/frontier 校验必须早于任何 publish");
	assert.match(GATE, /assertNewBuild\(/);
	assert.match(GATE, /PUBLISH_STATES\.FULLY_PUBLISHED/);
	assert.match(GATE, /classifyPublishState\(/);
});

test("workflow: app pointer pre-compared and moved only forward (never `--tag app` unconditionally)", () => {
	const carrier = blockByName("Publish carrier").run;
	assert.match(carrier, /--tag "\$CARRIER_PUBLISH_TAG"/);
	assert.match(GATE, /CARRIER_PUBLISH_TAG: result\.appDecision === "move" \? "app" : "app-staging"/);
	assert.match(GATE, /appDistTagDecision/);
	const tags = blockByName("Set and verify channel / app / latest dist-tags").run;
	assert.match(tags, /if \[\[ "\$APP_DECISION" == "move" \]\]; then[\s\S]*?npm dist-tag add "\$PACKAGE_NAME@\$CARRIER_VERSION" app/);
	assert.match(tags, /app dist-tag stays at newer\/equal carrier/);
	assert.match(tags, /--app-decision "\$APP_DECISION"/);
	assert.match(tags, /--app-before/);
});

test("workflow: alpha/rc channel anti-rollback — candidate vs channel, staging when not newer", () => {
	const tags = blockByName("Set and verify channel / app / latest dist-tags").run;
	assert.match(tags, /case "\$\{CHANNEL_DECISION:-move\}" in/);
	assert.match(tags, /keep\)[\s\S]*?echo "channel \$PLUGIN_TAG already at candidate/);
	assert.match(tags, /staging\)[\s\S]*?echo "::warning::channel \$PLUGIN_TAG=\$\{CHANNEL_CURRENT:-<unset>\} is newer/);
	assert.match(tags, /the channel is NOT moved \(anti-rollback\)/);
	assert.match(tags, /--channel-decision "\$\{CHANNEL_DECISION:-move\}"/);
	assert.match(tags, /--channel-before "\$\{CHANNEL_CURRENT:-\}"/);
	assert.match(GATE, /channelDistTagDecision/);
	assert.match(GATE, /PLUGIN_PUBLISH_TAG: stableKeep \|\| channelStaging \? stagingTag : result\.pluginTag/);
	assert.match(blockByName("Publish plugin").run, /--tag "\$PLUGIN_PUBLISH_TAG"/);
	// n2：旧的 dead latest echo 已移除；staging 分支绝不移动 channel。
	assert.doesNotMatch(tags, /latest dist-tag is prerelease\/bootstrap state/);
});

test("workflow: latest only advances for stable; prerelease publishes never move it", () => {
	const tags = blockByName("Set and verify channel / app / latest dist-tags").run;
	assert.match(tags, /if \[\[ "\$TAG_KIND" == "stable" \]\]; then[\s\S]*?if \[\[ "\$LATEST_DECISION" == "move" \]\]; then[\s\S]*?npm dist-tag add "\$PACKAGE_NAME@\$PLUGIN_VERSION" latest/);
	assert.match(tags, /latest dist-tag stays at newer\/equal version/);
	assert.match(tags, /prerelease never moves latest/);
	assert.match(tags, /--latest-decision "\$LATEST_DECISION"/);
	assert.match(GATE, /PLUGIN_PUBLISH_TAG: stableKeep/);
	assert.doesNotMatch(WORKFLOW_TEXT, /--tag latest[\s\\]/);
});

test("workflow: release intent before publish; unknown blocks; m7 leftover-intent recovery is reported", () => {
	const intentIndex = STEPS.indexOf(stepByName("Record release intent (submitted) in release-meta"));
	const carrierIndex = STEPS.indexOf(stepByName("Publish carrier"));
	assert.ok(intentIndex < carrierIndex, "发布意图必须在 npm publish 之前写入 release-meta");
	const intent = blockByName("Record release intent (submitted) in release-meta").run;
	assert.match(intent, /record-intent[\s\S]*?--tag "\$TAG"[\s\S]*?--integrity "\$integrity"[\s\S]*?--resume/);
	assert.match(WORKFLOW_TEXT, /release-visibility-unknown/);
	assert.match(WORKFLOW_TEXT, /release_meta_mark unknown/);
	assert.match(WORKFLOW_TEXT, /manual recovery required \(do not republish\/delete tag\)/);
	assert.match(WORKFLOW_TEXT, /E409[\s\S]*?polling visibility without republishing/);
	assert.match(WORKFLOW_TEXT, /--tag "\$TAG" --status published --note "dist-tags verified"/);
	assert.match(WORKFLOW_TEXT, /--integrity "\$remote_integrity"/);
	assert.match(WORKFLOW_TEXT, /release-meta-write-token-missing/);
	// m7：fully-published 重跑必须检测/报告残留 submitted 意图，并给出精确人工恢复指引。
	const readonly = blockByName("Fully-published rerun read-only verification").run;
	assert.match(readonly, /LEFTOVER_INTENT_STATUS/);
	assert.match(readonly, /leftover-intent/);
	assert.match(readonly, /mark-intent --status published/);
	assert.match(readonly, /docs\/10-release\.md §10\.3/);
	assert.match(GATE, /leftoverIntent/);
	assert.match(GATE, /LEFTOVER_INTENT_STATUS/);
});

test("workflow: m8 asserts BUILD vs manifest.app.version/carrier before publish", () => {
	const step = stepByName("Assert BUILD matches packaged manifest and carrier");
	assert.match(step.run, /verify-package/);
	assert.match(step.run, /--plugin-version "\$PLUGIN_VERSION"/);
	assert.match(step.run, /--carrier-version "\$CARRIER_VERSION"/);
	assert.match(step.run, /--build "\$BUILD"/);
	assert.ok(STEPS.indexOf(step) < STEPS.indexOf(stepByName("Record release intent (submitted) in release-meta")),
		"BUILD/manifest 断言必须在写发布意图与发布之前");
	assert.match(GATE, /build-manifest-mismatch/);
	assert.match(GATE, /carrier-version-mismatch/);
	assert.match(GATE, /plugin-version-mismatch/);
});

test("workflow: release-meta helper reuses an existing linked worktree", () => {
	// linked worktree 的 .git 是文件而不是目录；用 -d 会重复 git worktree add，导致第二次
	// 调用（Mark release intent published）以 git exit 128 失败。必须用 -e。
	const step = stepByName("Write release-meta helper functions");
	assert.match(step.run, /\[\[ ! -e "\$RELEASE_META_WT\/\.git" \]\]/);
	assert.doesNotMatch(step.run, /\[\[ ! -d "\$RELEASE_META_WT\/\.git" \]\]/);
});

test("workflow: keeps signed APK, drill, carrier pairing, concurrency and idempotent republish skip", () => {
	assert.match(WORKFLOW_TEXT, /group: npm-publish[\s\S]*?cancel-in-progress: false/);
	assert.match(blockByName("Build signed Android APK").run, /flutter build apk --release --no-pub/);
	assert.match(blockByName("Verify APK signing certificate").run, /verify --print-certs/);
	assert.match(blockByName("Build paired artifacts and run local release drill").run, /package-release\.sh --drill/);
	assert.match(blockByName("Publish carrier").run, /CARRIER_ALREADY_PUBLISHED[\s\S]*?skip republish/);
	assert.match(blockByName("Publish plugin").run, /PLUGIN_ALREADY_PUBLISHED[\s\S]*?skip republish/);
	assert.match(blockByName("Verify published tarball integrity").run, /dist\.integrity/);
	assert.match(WORKFLOW_TEXT, /carrier pluginContentSha256 mismatch/);
});

test("workflow: caches Gradle and runs Node/Flutter tests in parallel", () => {
	const cache = stepByName("Cache Gradle caches");
	assert.equal(cache.uses, "actions/cache@v4");
	assert.match(cache.with.path, /~\/\.gradle\/caches/);
	assert.match(cache.with.path, /~\/\.gradle\/wrapper/);
	assert.match(cache.with.key, /hashFiles\(.*dsh-mobile-app\/android\/.*gradle/);
	assert.match(cache.with["restore-keys"], /gradle-\$\{\{ runner\.os \}\}-v1-/);

	const parallel = stepByName("Run Node and Flutter tests in parallel");
	assert.match(parallel.run, /run_node_tests >"\$node_log" 2>&1 &/);
	assert.match(parallel.run, /wait "\$node_pid"/);
	assert.match(parallel.run, /flutter analyze --no-pub --no-fatal-infos/);
	assert.match(parallel.run, /flutter test --no-pub/);
	assert.match(parallel.run, /test failure \(node=\$\{node_rc\} flutter=\$\{flutter_rc\}\)/);
	assert.doesNotMatch(parallel.run, /GITHUB_ENV/);

	assert.equal(STEPS.some((step) => step.name === "Run Node tests"), false);
	assert.equal(STEPS.some((step) => step.name === "Run Flutter analysis and tests"), false);
});
