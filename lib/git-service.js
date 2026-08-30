import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * Parse the NUL-delimited output from `git for-each-ref`.
 *
 * Git appends a line ending after each formatted record, so every record after
 * the first one starts with `\n`. Strip only record line endings before
 * splitting fields; ref names themselves remain untouched.
 */
const versionDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function parseGitBranches(text) {
	return text.split("\0")
		.map((line) => line.replace(/^[\r\n]+|[\r\n]+$/g, ""))
		.filter(Boolean)
		.map((line) => {
			const [name, oid, upstream = ""] = line.split("\t");
			return { name, oid, upstream: upstream || null, remote: name.startsWith("refs/remotes/"), displayName: name.replace(/^refs\/(heads|remotes)\//, "") };
		});
}

/** Parse NUL-delimited commit records and discard framing line endings. */
export function parseGitCommits(text) {
	return text.split("\0")
		.map((record) => record.replace(/^[\r\n]+|[\r\n]+$/g, ""))
		.filter(Boolean)
		.map((record) => {
			const [oid, parent, author, timestamp, subject, refs] = record.split("\x1f");
			return { oid, parents: parent ? parent.split(" ") : [], author, timestamp: Number(timestamp) || 0, subject, refs: refs ? refs.split(",").map((ref) => ref.trim()).filter(Boolean) : [] };
		});
}

/** Parse `git status --porcelain=v1 -z -b`. Rename/copy records carry the
 * destination and source as two consecutive NUL records. */
export function parseGitStatus(text) {
	const records = text.split("\0");
	const header = (records.shift() ?? "").replace(/[\r\n]+$/, "");
	const branch = header.startsWith("## ") ? header.slice(3).split("...")[0].split(" [")[0] : "HEAD";
	const ahead = Number(header.match(/ahead (\d+)/)?.[1] ?? 0) || 0;
	const behind = Number(header.match(/behind (\d+)/)?.[1] ?? 0) || 0;
	const items = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (!record) continue;
		const code = record.slice(0, 2);
		const path = record.slice(3);
		if (!path) continue;
		const rename = code.includes("R") || code.includes("C");
		const oldPath = rename ? records[++i] : undefined;
		items.push({ path, ...(oldPath ? { oldPath } : {}), index: code[0], worktree: code[1], rename });
	}
	return { branch, ahead, behind, entries: items, counts: { total: items.length, staged: items.filter((x) => x.index !== " " && x.index !== "?").length, unstaged: items.filter((x) => x.worktree !== " ").length, untracked: items.filter((x) => x.index === "?" && x.worktree === "?").length } };
}

// Read-only Git provider for Slice A.  All process execution goes through the
// DSH subprocess service; the mobile bridge never shells out directly.
export function createGitService(ctx, { onChanged } = {}) {
	const unavailable = (reason = "git-provider-unavailable") => {
		const e = new Error(reason);
		e.code = reason;
		e.status = ({ "workspace-not-allowed": 403, "not-git-repository": 404, "graph-stale": 409, "graph-tip-invalid": 409, "git-provider-unavailable": 503 })[reason] ?? 503;
		return e;
	};

	const registry = () => {
		try { return ctx.get("workspaceRegistry"); } catch { return undefined; }
	};
	const registeredRoots = () => (registry()?.list?.() ?? [])
		.map((w) => typeof w?.path === "string" ? w.path : "")
		.filter(Boolean);
	const inside = (child, root) => {
		const r = relative(resolve(root), resolve(child));
		return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
	};
	const assertAllowed = async (cwd) => {
		if (typeof cwd !== "string" || cwd.trim() === "") throw unavailable("workspace-not-allowed");
		let real;
		try { real = await realpath(cwd); } catch { throw unavailable("workspace-not-allowed"); }
		const roots = registeredRoots();
		if (!roots.some((root) => inside(real, root))) throw unavailable("workspace-not-allowed");
		return real;
	};

	const subprocessOf = () => {
		try { return ctx.get("subprocess"); } catch {}
		try { return ctx.subprocess; } catch { return undefined; }
	};
	const run = async (argv, cwd, signal, options = {}) => {
		const subprocess = subprocessOf();
		if (!subprocess || typeof subprocess.spawn !== "function") throw unavailable();
		const child = subprocess.spawn({
			argv: [process.platform === "win32" ? "git.exe" : "git", ...argv], cwd,
			env: options.env,
			input: options.input,
			stdio: { stdin: options.input === undefined ? "ignore" : { maxBytes: 64 * 1024 }, stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 4 * 1024 * 1024 } },
			graceMs: 10_000, signal,
		});
		const done = await child.done;
		const read = async (stream) => {
			try { return (await stream?.readFrom?.(0))?.text ?? ""; } catch { return ""; }
		};
		const stdout = await read(child.collected?.stdout);
		const stderr = await read(child.collected?.stderr);
		if (done?.exitCode !== 0) {
			const e = new Error(stderr.trim() || `git exited with ${done?.exitCode ?? "unknown"}`);
			const missing = done?.exitCode === 127 || /not found|cannot run|找不到|无法找到/i.test(stderr);
			e.code = missing ? "git-provider-unavailable" : "git-command-failed";
			e.status = missing ? 503 : 400;
			throw e;
		}
		return stdout;
	};

	const gitRoot = async (cwd, signal) => {
		const allowed = await assertAllowed(cwd);
		let root;
		try { root = (await run(["-C", allowed, "rev-parse", "--show-toplevel"], allowed, signal)).trim(); }
		catch (e) {
			if (e?.code === "git-command-failed" && /not a git repository|不是 git 仓库|未发现 git 仓库/i.test(e.message)) throw unavailable("not-git-repository");
			throw e;
		}
		if (!root) throw unavailable("not-git-repository");
		const realRoot = await assertAllowed(root);
		return realRoot;
	};
	const knownRepositories = new Map();
	const commonDomains = new Map();
	const repositoryId = (root) => {
		const id = `repo_${createHash("sha256").update(root).digest("hex").slice(0, 32)}`;
		knownRepositories.set(id, root);
		return id;
	};
	const writeDomainsFor = async (root, id = repositoryId(root)) => {
		let common = (await run(["-C", root, "rev-parse", "--git-common-dir"], root)).trim();
		common = await realpath(resolve(root, common));
		const commonDomain = commonDomains.get(common) ?? `git-common_${createHash("sha256").update(common).digest("hex").slice(0, 32)}`;
		commonDomains.set(common, commonDomain);
		return { worktreeDomain: `git-worktree_${id}`, commonDomain };
	};

	const observedRoots = new Set();
	const context = async ({ sessionId, cwd } = {}) => {
		let target = cwd;
		if (!target && sessionId) {
			try { target = ctx.get("sessions")?.get?.(sessionId)?.header?.cwd; } catch {}
		}
		if (!target) throw unavailable("workspace-not-allowed");
		const root = await gitRoot(target);
		observedRoots.add(root);
		const id = repositoryId(root);
		// Coordination domains are provider-internal; expose only the stable repository identity.
		return { repositoryId: id, name: root.split(/[\\/]/).at(-1) || "repository", capabilities: capabilities() };
	};
	const registryAvailable = () => { try { return typeof ctx.get("workspaceRegistry")?.list === "function"; } catch {} try { return typeof ctx.workspaceRegistry?.list === "function"; } catch { return false; } };
	const capabilities = () => { const provider = Boolean(subprocessOf()?.spawn); const workspace = registryAvailable(); return { serviceDefinitionVersion: "1.0.0", providerVersion: "0.1.0", providerSupportedDefinitionRange: "^1.0.0", gitMobileContractVersion: "2.0.0", minSupportedMobileContractVersion: "2.0.0", available: provider && workspace, read: provider && workspace, writes: false, reason: !provider ? "git-provider-unavailable" : !workspace ? "workspace-registry-unavailable" : null, externalConcurrencyProtection: "detect-only", features: { status: true, branches: true, graph: true, readCommitDetails: true, commit: false, diff: true, branchSwitch: false, createBranch: false, fetch: false, pullMerge: false, pullRebase: false, push: false, sync: false, abort: false, handoff: false, tags: false } }; };
	const rootFor = async (repositoryIdValue) => {
		if (typeof repositoryIdValue !== "string" || repositoryIdValue === "") throw unavailable("workspace-not-allowed");
		const known = knownRepositories.get(repositoryIdValue);
		if (known) return gitRoot(known);
		// Legacy read-only callers may still send a workspace path during the
		// compatibility window; write APIs use the opaque repositoryId returned by
		// context and never expose this fallback.
		if (isAbsolute(repositoryIdValue)) return gitRoot(await assertAllowed(repositoryIdValue));
		for (const workspace of registeredRoots()) {
			try {
				const candidate = await gitRoot(workspace);
				if (repositoryId(candidate) === repositoryIdValue) return candidate;
			} catch {}
		}
		throw unavailable("workspace-not-allowed");
	};

	const graphSnapshots = new Map();
	const graphSnapshotTtlMs = 5 * 60 * 1000;
	const graphRefPattern = /^refs\/(?:heads|remotes)\/[^\0\r\n]+$/;
	const maxGraphTips = 3;
	const validGraphRef = (name) => graphRefPattern.test(name) && !name.includes("..") && !name.includes("//") && !name.includes("@{") && !/(^|\/)\.|\/$|\.$/.test(name) && !/[\x00-\x20~^:?*\[\]\\]/.test(name);
	const graphCursor = (snapshotId, offset) => Buffer.from(JSON.stringify({ snapshotId, offset }), "utf8").toString("base64url");
	const parseGraphCursor = (value) => {
		if (!value) return null;
		try {
			const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
			if (!parsed || typeof parsed.snapshotId !== "string" || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error("invalid cursor");
			return parsed;
		} catch {
			const e = unavailable("graph-stale");
			e.status = 409;
			throw e;
		}
	};
	const sanitizeRemoteUrl = (value) => {
		const raw = String(value ?? "").trim();
		if (!raw) return null;
		// A local-path remote is useful to the provider but would disclose a host
		// filesystem path to the mobile client. Keep only its non-sensitive kind.
		if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(raw)) return "[local-remote]";
		if (/^file:\/\//i.test(raw)) return "file://";
		try {
			const url = new URL(raw);
			url.username = "";
			url.password = "";
			url.search = "";
			url.hash = "";
			return url.toString().replace(/\/$/, "");
		} catch {
			// Only support the scp-like transport form explicitly. Unknown syntax
			// is omitted instead of being returned as a possible credential leak.
			const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$/.exec(raw);
			if (!scp) return null;
			return `${scp[1]}:${scp[2].replace(/[?#].*$/, "")}`;
		}
	};
	const safeRemoteName = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
	const service = {
		capabilities,
		context,
		runCommand: run,
		repositoryRoot: rootFor,
		repositoryRootForWrite: async (id) => {
			if (typeof id !== "string" || !/^repo_[0-9a-f]{32}$/.test(id)) throw unavailable("workspace-not-allowed");
			return rootFor(id);
		},
		writeDomains: async (id) => { const root = await rootFor(id); return writeDomainsFor(root, id); },
		coordinationDomains: async (id, kind, params = {}) => {
			const domains = await service.writeDomains(id);
			if (kind === "git.stage" || kind === "git.unstage") return [domains.worktreeDomain];
			if (kind === "git.commit") return [domains.commonDomain, domains.worktreeDomain];
			if (kind === "git.branch-create") return [domains.commonDomain];
			if (kind === "git.branch-rename") {
				const current = await service.repositoryRoot(id);
				let head = "";
				try { head = (await service.runCommand(["-C", current, "symbolic-ref", "--quiet", "--short", "HEAD"], current)).trim(); } catch {}
				return params?.oldName === head ? [domains.commonDomain, domains.worktreeDomain] : [domains.commonDomain];
			}
			if (kind === "git.branch-switch") return params?.remoteRef ? [domains.commonDomain, domains.worktreeDomain] : [domains.worktreeDomain];
			if (kind === "git.fetch") return [domains.commonDomain];
			if (kind === "git.pull" || kind === "git.sync" || kind === "git.abort") return [domains.commonDomain, domains.worktreeDomain];
			if (kind === "git.push") return params?.setUpstream ? [domains.commonDomain, domains.worktreeDomain] : [domains.commonDomain];
			return [domains.commonDomain];
		},
		async remotes(id) {
			const root = await rootFor(id);
			observedRoots.add(root);
			const names = (await run(["-C", root, "remote"], root)).split(/\r?\n/).map((name) => name.trim()).filter(safeRemoteName);
			const refs = parseGitBranches(await run(["-C", root, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(upstream:short)%00", "refs/heads", "refs/remotes"], root));
			const localBranches = refs.filter((item) => item.name.startsWith("refs/heads/")).map((item) => ({ name: item.name.slice("refs/heads/".length), oid: item.oid, upstream: item.upstream }));
			const remotes = [];
			for (const name of names) {
				let fetchUrl = null;
				let pushUrl = null;
				try { fetchUrl = sanitizeRemoteUrl(await run(["-C", root, "remote", "get-url", name], root)); } catch {}
				try { pushUrl = sanitizeRemoteUrl(await run(["-C", root, "remote", "get-url", "--push", name], root)); } catch { pushUrl = fetchUrl; }
				const prefix = `refs/remotes/${name}/`;
				const branches = refs.filter((item) => item.name.startsWith(prefix) && !item.name.endsWith("/HEAD")).map((item) => ({ branch: item.name.slice(prefix.length), remoteRef: item.name, oid: item.oid }));
				remotes.push({ name, fetchUrl, pushUrl, branches });
			}
			return { repositoryId: repositoryId(root), remotes, localBranches, stateVersion: versionDigest({ remotes, localBranches }) };
		},
		async status(id) { const root = await rootFor(id); observedRoots.add(root); return { repositoryId: repositoryId(root), ...parseGitStatus(await run(["-C", root, "status", "--porcelain=v1", "-z", "-b"], root)) }; },
		async branches(id) { const root = await rootFor(id); const text = await run(["-C", root, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(upstream:short)%00", "refs/heads", "refs/remotes"], root); return { repositoryId: repositoryId(root), branches: parseGitBranches(text) }; },
		async graph(id, { limit = 100, cursor, refs } = {}) {
			const root = await rootFor(id);
			observedRoots.add(root);
			for (const [key, value] of graphSnapshots) if (value.expiresAt <= Date.now()) graphSnapshots.delete(key);
			const n = Math.max(1, Math.min(200, Number(limit) || 100));
			let snapshot;
			const parsedCursor = parseGraphCursor(cursor);
			if (parsedCursor) {
				snapshot = graphSnapshots.get(parsedCursor.snapshotId);
				if (!snapshot || snapshot.root !== root || snapshot.expiresAt <= Date.now()) {
					const e = unavailable("graph-stale"); e.status = 409; throw e;
				}
			} else {
				const requested = Array.isArray(refs) && refs.length > 0 ? refs : [{ name: "HEAD", tipOid: null }];
				if (requested.length > maxGraphTips) { const e = unavailable("graph-too-many-tips"); e.status = 400; throw e; }
				if (new Set(requested.map((item) => String(item?.name ?? ""))).size !== requested.length) { const e = unavailable("graph-tip-invalid"); e.status = 400; throw e; }
				const tips = [];
				for (const item of requested) {
					const name = String(item?.name ?? "");
					if (name !== "HEAD" && !validGraphRef(name)) { const e = unavailable("graph-tip-invalid"); e.status = 400; throw e; }
					let value = "";
					try { value = (await run(["-C", root, "rev-parse", "--verify", `${name}^{commit}`], root)).trim(); }
					catch (e) {
						// A new repository has an unborn HEAD. It is a valid empty graph;
						// explicit refs, however, remain invalid/stale.
						if (name === "HEAD" && e?.code === "git-command-failed") continue;
						throw e?.code === "git-command-failed" ? Object.assign(unavailable("graph-tip-invalid"), { status: 409 }) : e;
					}
					if (!value && name === "HEAD") continue;
					if (!/^[0-9a-f]{4,64}$/i.test(value) || (item?.tipOid && String(item.tipOid).toLowerCase() !== value.toLowerCase())) { const e = unavailable("graph-tip-invalid"); e.status = 409; throw e; }
					tips.push({ name, tipOid: value });
				}
				const snapshotId = randomUUID();
				snapshot = { id: snapshotId, root, tips, expiresAt: Date.now() + graphSnapshotTtlMs };
				graphSnapshots.set(snapshotId, snapshot);
			}
			for (const tip of snapshot.tips) {
				let current;
				try { current = (await run(["-C", root, "rev-parse", "--verify", `${tip.name}^{commit}`], root)).trim(); }
				catch (e) { if (e?.code === "git-command-failed") { const stale = unavailable("graph-stale"); stale.status = 409; throw stale; } throw e; }
				if (current.toLowerCase() !== tip.tipOid.toLowerCase()) { const e = unavailable("graph-stale"); e.status = 409; throw e; }
			}
			const offset = parsedCursor ? parsedCursor.offset : 0;
			if (parsedCursor && parsedCursor.snapshotId !== snapshot.id) { const e = unavailable("graph-stale"); e.status = 409; throw e; }
			if (snapshot.tips.length === 0) return { repositoryId: repositoryId(root), commits: [], snapshotId: snapshot.id, tips: [], nextCursor: null };
			const args = ["-C", root, "log", "--topo-order", "--date-order", "--decorate=full", `--skip=${offset}`, `--max-count=${n}`, "--format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1f%D%x00", ...snapshot.tips.map((tip) => tip.name)];
			const commits = parseGitCommits(await run(args, root));
			return { repositoryId: repositoryId(root), commits, snapshotId: snapshot.id, tips: snapshot.tips, nextCursor: commits.length === n ? graphCursor(snapshot.id, offset + commits.length) : null };
		},
		async commit(id, oid) { const root = await rootFor(id); if (!/^[0-9a-f]{4,64}$/i.test(String(oid ?? ""))) throw unavailable("invalid-oid"); const text = await run(["-C", root, "show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x00", oid], root); const [hash, parents, author, email, timestamp, message] = text.split("\0")[0].split("\x1f"); const stat = await run(["-C", root, "show", "--stat", "--format=", oid], root); return { repositoryId: repositoryId(root), oid: hash, parents: parents ? parents.split(" ") : [], author, email, timestamp: Number(timestamp) || 0, message: message?.trim() ?? "", stat }; },
		async diff(id, { kind = "working", oid, path, limit = 200 } = {}) { const root = await rootFor(id); let args; if (kind === "commit") { if (!oid || !/^[0-9a-f]{4,64}$/i.test(oid)) throw unavailable("invalid-oid"); args = ["-C", root, "show", "--format=", "--no-ext-diff", "--unified=3", "--root", oid]; } else { args = ["-C", root, "diff", "--no-ext-diff", "--unified=3"]; if (kind === "staged") args.push("--cached"); } if (path) args.push("--", path); const lines = (await run(args, root)).split("\n"); const n = Math.max(1, Math.min(1000, Number(limit) || 200)); return { repositoryId: repositoryId(root), kind, oid: oid ?? null, path: path ?? null, text: lines.slice(0, n).join("\n"), truncated: lines.length > n }; },
		diagnostics() { return { ...capabilities(), registeredWorkspaces: registeredRoots().length }; },
		start() {
			if (service._timer || !subprocessOf()?.spawn || typeof onChanged !== "function") return;
			service._pollOnce = async () => {
				for (const root of observedRoots) {
					try { const value = await service.status(root); const sig = JSON.stringify([value.branch, value.ahead, value.behind, value.entries]); if (service._snapshots?.get(root) !== sig) { service._snapshots ??= new Map(); service._snapshots.set(root, sig); onChanged(root); } } catch {}
				}
			};
			service._timer = setInterval(service._pollOnce, 30_000);
			service._timer.unref?.();
		},
		stop() { if (service._timer) clearInterval(service._timer); service._timer = null; observedRoots.clear(); service._snapshots?.clear(); },
		onChanged,
	};
	return service;
}
