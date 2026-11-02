// 发布工具测试用的**离线假适配器**（issue #43）。
//
// 通过 `--adapters <this file>` + 环境变量 DSH_RELEASE_FAKE_STATE=<state.json> 注入：
// 所有 git / npm 访问都从 state.json 读取，零网络、零真实仓库写入。
// 需要记录副作用的测试可设置 DSH_RELEASE_FAKE_CALLS=<jsonl>，createBranchWithFile 会追加一行。
import fs from "node:fs";

function readState(env) {
	const file = env.DSH_RELEASE_FAKE_STATE;
	if (!file) throw new Error("DSH_RELEASE_FAKE_STATE 未设置");
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function recordCall(env, entry) {
	if (!env.DSH_RELEASE_FAKE_CALLS) return;
	fs.appendFileSync(env.DSH_RELEASE_FAKE_CALLS, `${JSON.stringify(entry)}\n`, "utf8");
}

export function createAdapters({ env = process.env } = {}) {
	const state = readState(env);
	const git = {
		fetch({ remotes = ["origin", "github"] } = {}) {
			recordCall(env, { kind: "git.fetch", remotes });
			if (state.failFetch) {
				const error = new Error(state.failFetch);
				if (state.failFetchReason) error.releaseReason = state.failFetchReason;
				throw error;
			}
		},
		revParse(ref) {
			if (state.revParse?.[ref] !== undefined) return state.revParse[ref];
			const meta = /^refs\/remotes\/([^/]+)\/release-meta$/.exec(String(ref));
			if (meta) return state.releaseMeta?.[meta[1]]?.sha ?? null;
			if (ref === "HEAD") return "HEAD";
			return null;
		},
		show(ref, filePath) {
			if (state.refFiles?.[ref]?.[filePath] !== undefined) return state.refFiles[ref][filePath];
			const meta = /^refs\/remotes\/([^/]+)\/release-meta$/.exec(String(ref));
			if (meta) {
				const source = state.releaseMeta?.[meta[1]];
				return source && filePath === "build-policy.json" ? source.content : null;
			}
			return state.tagFiles?.[ref]?.[filePath] ?? null;
		},
		listTags() {
			return state.tags ?? [];
		},
		listRemoteTags(remote) {
			if (state.remoteTagsError?.[remote]) throw new Error(state.remoteTagsError[remote]);
			return state.remoteTags?.[remote] ?? [];
		},
		createBranchWithFile(args) {
			recordCall(env, { kind: "git.createBranchWithFile", ...args });
			return { branch: args.branch, commit: "f".repeat(40), base: "e".repeat(40), path: args.path };
		},
	};
	const npm = {
		listVersions() {
			recordCall(env, { kind: "npm.listVersions" });
			if (state.npmError) throw new Error(state.npmError);
			return state.npm?.versions ?? [];
		},
		viewVersion(_packageName, version) {
			if (state.npmViewError) throw new Error(state.npmViewError);
			return state.npm?.metadata?.[version] ?? null;
		},
		distTags() {
			if (state.npmDistTagsError) throw new Error(state.npmDistTagsError);
			return state.npm?.distTags ?? {};
		},
		downloadTarball(_packageName, version) {
			const file = state.npm?.tarballs?.[version];
			if (!file) throw new Error(`fake tarball missing: ${version}`);
			return { file, filename: file.split("/").pop() };
		},
	};
	return { git, npm };
}
