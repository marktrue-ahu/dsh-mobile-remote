// 可回滚包的独立运行闭包。内容标识只覆盖插件代码；本模块的 digest 覆盖整个冻结包。
// 根只复制 package.json + lib，依赖按 Node 实际解析的包身份冻结（不复制 profile/secret）。
//
// App 载体排除（设计稿 §5.5）：载体是随包的**数据依赖**（72MB APK），不是运行依赖。
// 只有「根包显式声明 + 身份校验通过」的载体在**建图阶段**（要求可执行入口之前）被跳过；
// 建图、冻结复制、冻结后闭包校验、快照复用与监督器恢复都走同一条判定
// `appCarrierExclusion`，普通依赖自报 `dsh.appCarrier` 不构成豁免。
import { createHash } from "node:crypto";
import {
	chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
	readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { appCarrierExclusion } from "./app-carrier.js";

export const RUNTIME_COMPLETE_MARKER = ".complete";
const MARKER_SCHEMA = 1;

function contained(root, target) {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// 目标可能尚不存在；先解析已有祖先的 symlink，禁止借路径别名把 staging 写回源。
function canonicalDestination(destination) {
	const missing = [basename(destination)];
	let parent = dirname(destination);
	while (true) {
		try { return join(realpathSync(parent), ...missing); }
		catch (error) {
			if (error.code !== "ENOENT") throw error;
			try {
				lstatSync(parent); // 已有 broken symlink 不是可创建的缺失祖先。
				throw new Error("snapshot-destination-broken-ancestor");
			} catch (entryError) { if (entryError.code !== "ENOENT") throw entryError; }
			missing.unshift(basename(parent));
			parent = dirname(parent);
		}
	}
}

// 全新的 Node 进程：无继承的 loader/NODE_OPTIONS、NODE_PATH、HOME 或 module cache。
// 静态 dependencies 图查缺失的 lazy 依赖；加载钩子校验实际加载图（含未声明 require/import）。
const WORKER = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const root = fs.realpathSync(input.root);
const loaded = new Set();
const contains = (target) => {
	const rel = path.relative(root, target);
	return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
const readPackage = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
function binding(req, name, optional = false) {
	if (!/^(?:@[^/\s]+\/)?[^./\s][^/\s]*$/.test(name) || isBuiltin(name)) throw new Error(name + ':invalid-dependency-name');
	let source;
	for (const lookup of req.resolve.paths(name) ?? []) {
		const candidate = path.join(lookup, name);
		// scoped 容器本身的 broken symlink 也不能被上层同名包兜底。
		if (name.startsWith('@')) {
			const scope = path.join(lookup, name.split('/')[0]);
			let scopeStat;
			try { scopeStat = fs.lstatSync(scope); }
			catch (error) { if (error.code !== 'ENOENT') throw error; }
			if (scopeStat?.isSymbolicLink()) {
				try { fs.realpathSync(scope); }
				catch (error) { throw new Error(name + ':broken-required-link(' + error.code + ')'); }
			}
		}
		try { fs.lstatSync(candidate); }
		catch (error) { if (error.code === 'ENOENT') continue; throw error; }
		try { source = fs.realpathSync(candidate); }
		catch (error) { throw new Error(name + ':broken-required-link(' + error.code + ')'); }
		if (!fs.statSync(source).isDirectory()) throw new Error(name + ':dependency-not-directory');
		break;
	}
	if (!source) {
		if (optional) return null;
		throw new Error(name + ':无法解析(MODULE_NOT_FOUND)');
	}
	let entry;
	try { entry = fs.realpathSync(req.resolve(name)); }
	catch (error) { throw new Error(name + ':无法解析(' + error.code + ':' + error.message + ')'); }
	if (input.mode === 'verify' && (!contains(source) || !contains(entry))) {
		throw new Error(name + ':解析到解包目录之外(' + entry + ')');
	}
	return { source, entry };
}
function graph() {
	const nodes = [{ source: root, dependencies: Object.create(null) }];
	const ids = new Map([[root, 0]]);
	// 只有父进程用「根包声明 + 完整身份校验」确认过的载体别名才会出现在 input.carrier。
	// 必须在要求可执行入口（binding 的 req.resolve）之前跳过它：载体是数据包，没有 main/exports。
	const excludedAlias = typeof input.carrier?.alias === 'string' ? input.carrier.alias : null;
	for (let index = 0; index < nodes.length; index++) {
		if (nodes.length > 4096) throw new Error('runtime-closure-too-large');
		const node = nodes[index];
		const pkg = readPackage(node.source);
		node.name = pkg.name ?? '';
		const req = createRequire(path.join(node.source, 'package.json'));
		const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
		for (const name of Object.keys(deps).sort()) {
			// 仅根包自己的载体别名豁免；其他包即使同名依赖也照常进入闭包。
			if (index === 0 && excludedAlias !== null && name === excludedAlias) continue;
			const found = binding(req, name, Object.hasOwn(pkg.optionalDependencies ?? {}, name));
			if (!found) continue;
			let id = ids.get(found.source);
			if (id === undefined) {
				id = nodes.length;
				ids.set(found.source, id);
				nodes.push({ source: found.source, dependencies: Object.create(null) });
			}
			node.dependencies[name] = id;
		}
	}
	return nodes;
}
function checkLoad(filename) {
	if (isBuiltin(filename)) return;
	const real = fs.realpathSync(filename);
	if (!contains(real)) throw new Error('runtime-load-outside-package(' + real + ')');
	loaded.add(real);
}
async function run() {
	const nodes = graph();
	if (input.mode === 'graph') return { ok: true, nodes };
	if (typeof Module.registerHooks !== 'function') throw new Error('runtime-closure-verification-requires-Node-registerHooks');
	const original = Module._resolveFilename;
	Module._resolveFilename = function(...args) {
		const filename = original.apply(this, args);
		checkLoad(filename);
		return filename;
	};
	// 新版 Node 的同步 hooks 同时覆盖传递 ESM import 和 CJS require。
	Module.registerHooks({ resolve(specifier, context, nextResolve) {
		const result = nextResolve(specifier, context);
		if (result.url.startsWith('file:')) checkLoad(fileURLToPath(result.url));
		else if (!result.url.startsWith('node:')) throw new Error('runtime-load-unsupported-url(' + result.url + ')');
		return result;
	} });
	for (const node of nodes) {
		const req = createRequire(path.join(node.source, 'package.json'));
		for (const [name, id] of Object.entries(node.dependencies)) {
			try {
				const dependency = req(name);
				if (name === 'qrcode' || nodes[id].name === 'qrcode') {
					if (typeof dependency.toBuffer !== 'function') throw new Error('qrcode.toBuffer missing');
					const png = await dependency.toBuffer('dsh-runtime-closure-smoke', { type: 'png', width: 64, margin: 1, errorCorrectionLevel: 'M' });
					if (!Buffer.isBuffer(png) || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
						throw new Error('qrcode.toBuffer did not produce PNG');
					}
				}
			} catch (error) { throw new Error(name + ':加载失败(' + error.message + ')'); }
		}
	}
	return { ok: true, dependencies: Object.keys(nodes[0].dependencies), packageCount: nodes.length, loadedFiles: [...loaded].sort() };
}
try { process.stdout.write('\n__DSH_CLOSURE_RESULT__' + JSON.stringify(await run()) + '\n'); }
catch (error) { process.stdout.write('\n__DSH_CLOSURE_RESULT__' + JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1; }
`;

function cleanupTemporary(dir, parent) {
	// 删除前必须核验实际绝对目标：只能是本次 mkdtemp 分配的直接子目录。
	if (!isAbsolute(dir) || dirname(dir) !== parent || !basename(dir).startsWith(".dsh-runtime-")) {
		throw new Error("unsafe-temporary-cleanup");
	}
	rmSync(dir, { recursive: true, force: true });
}

function runWorker(root, mode, carrier = null) {
	const parent = realpathSync(tmpdir());
	const scratch = mkdtempSync(join(parent, ".dsh-runtime-check-"));
	try {
		const child = spawnSync(process.execPath, ["--no-global-search-paths", "--input-type=module", "-e", WORKER], {
			input: JSON.stringify({ root, mode, carrier }), encoding: "utf8", cwd: scratch,
			env: { PATH: process.env.PATH ?? "", HOME: scratch, TMPDIR: scratch, TEMP: scratch, TMP: scratch, LANG: "C" },
			timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
		});
		if (child.error) return { ok: false, error: `runtime-check-failed: ${child.error.message}` };
		const resultLine = child.stdout.split("\n").filter((line) => line.startsWith("__DSH_CLOSURE_RESULT__")).at(-1);
		if (!resultLine) return { ok: false, error: `runtime-check-no-result: exit=${child.status} ${child.stderr.trim()}` };
		const result = JSON.parse(resultLine.slice("__DSH_CLOSURE_RESULT__".length));
		if (child.status !== 0 && result.ok) return { ok: false, error: `runtime-check-exit-${child.status}` };
		return result;
	} finally {
		cleanupTemporary(scratch, parent);
	}
}

function inventory(packageRoot) {
	const root = realpathSync(packageRoot);
	const records = [];
	const visit = (dir, rel = "") => {
		for (const name of readdirSync(dir).sort()) {
			if (rel === "" && name === RUNTIME_COMPLETE_MARKER) continue;
			const full = join(dir, name);
			const child = rel ? `${rel}/${name}` : name;
			const st = lstatSync(full);
			if (st.isSymbolicLink()) {
				const real = realpathSync(full); // broken 链接也必须失败，不允许 skip。
				if (!contained(root, real)) throw new Error(`symlink-outside-package: ${child}`);
				// 只记录链接，不递归，可覆盖循环依赖；目标的文件另有独立记录。
				records.push([child, "link", readlinkSync(full)]);
			} else if (st.isDirectory()) {
				records.push([child, "dir"]);
				visit(full, child);
			} else if (st.isFile()) {
				records.push([child, "file", st.mode & 0o777, createHash("sha256").update(readFileSync(full)).digest("hex")]);
			} else throw new Error(`unsupported-package-entry: ${child}`);
		}
	};
	visit(root);
	const digest = createHash("sha256").update("dsh-runtime-closure/v1\n").update(JSON.stringify(records)).digest("hex");
	return { digest, entries: records.length };
}

// 载体排除的单一判定点（建图/冻结/冻结后校验/复用恢复共用）：
//   - 通过身份校验 → 返回可跳过的别名；
//   - 根包声明了、作用域里也确实有候选，但候选身份不符/多义 → fail-closed，带稳定 reason；
//   - 未声明或未安装 → 正常（可选依赖缺失不阻塞闭包）。
// 普通依赖自报 dsh.appCarrier 不会走到这里，也不会被豁免。
function carrierExclusion(root) {
	const exclusion = appCarrierExclusion({ root });
	if (exclusion?.exclude === true && typeof exclusion.alias === "string") {
		return { ok: true, carrier: { alias: exclusion.alias } };
	}
	if (exclusion?.hard === true) return { ok: false, error: `app-carrier-invalid: ${exclusion.reason}` };
	return { ok: true, carrier: null };
}

/**
 * 无 marker 也可验证发行 tgz：全部声明依赖与 smoke 实际加载文件均在 packageRoot 内。
 * qrcode.toBuffer(PNG) 覆盖 lazy API；CJS + ESM require/import 均做 realpath containment。
 * 需要支持 module.registerHooks 的 Node（22.15+/23.5+）；不支持时 fail-closed，不降为只核 CJS。
 * 根包显式声明且身份校验通过的 App 载体不进入闭包（数据依赖，不是运行依赖）。
 */
export function verifyRuntimeClosure(packageRoot) {
	try {
		if (!statSync(join(packageRoot, "lib")).isDirectory()) throw new Error("package-lib-missing");
		inventory(packageRoot); // 任何树内外链/broken 链接均拒绝。
		const root = realpathSync(packageRoot);
		const exclusion = carrierExclusion(root);
		if (!exclusion.ok) return { ok: false, error: exclusion.error };
		return runWorker(root, "verify", exclusion.carrier);
	} catch (error) {
		return { ok: false, error: String(error.message ?? error) };
	}
}

/** digest、marker schema、完整加载图全过，才可以复用快照。旧的时间戳 marker 一律拒绝。 */
export function verifyFrozenPackage(packageRoot) {
	try {
		const markerPath = join(packageRoot, RUNTIME_COMPLETE_MARKER);
		if (!lstatSync(markerPath).isFile()) throw new Error("snapshot-marker-not-file");
		const marker = JSON.parse(readFileSync(markerPath, "utf8"));
		if (marker.schema !== MARKER_SCHEMA || marker.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(marker.digest ?? "")) {
			throw new Error("snapshot-marker-invalid");
		}
		const actual = inventory(packageRoot);
		if (marker.digest !== actual.digest || marker.entries !== actual.entries) throw new Error("snapshot-integrity-mismatch");
		const runtime = verifyRuntimeClosure(packageRoot);
		return runtime.ok ? { ...runtime, digest: actual.digest } : runtime;
	} catch (error) {
		return { ok: false, error: String(error.message ?? error) };
	}
}

export function frozenPackageReady(packageRoot) {
	return verifyFrozenPackage(packageRoot).ok;
}

function copyPayload(source, destination, copyFile, ancestors = new Set()) {
	const real = realpathSync(source); // 必需链接缺失必须 throw。
	const st = statSync(real);
	if (st.isFile()) {
		const result = copyFile(real, destination);
		if (result?.ok === false) throw new Error(result.error ?? "copy-file-failed");
		chmodSync(destination, st.mode & 0o777);
		return;
	}
	if (!st.isDirectory()) throw new Error(`unsupported-source-entry: ${source}`);
	if (ancestors.has(real)) throw new Error(`source-symlink-cycle: ${source}`);
	const next = new Set(ancestors).add(real);
	mkdirSync(destination, { recursive: true });
	for (const name of readdirSync(real).sort()) {
		// 不复制安装布局 / VCS 元数据；由真实解析的图重新构造 node_modules。
		if (name === "node_modules" || name === ".git") continue;
		copyPayload(join(real, name), join(destination, name), copyFile, next);
	}
}

/**
 * 同步、fail-closed、不可覆盖的快照发布。
 * copyFile(src,dest) 可注入真实拷贝故障；throw 或 {ok:false,error} 都拒绝，验证前无 .complete。
 * destination 必须尚不存在（损坏的旧目录由调用方拒绝使用，不能当可复用快照）。
 */
export function freezePackage({ sourceRoot, destination, copyFile = copyFileSync } = {}) {
	let staging;
	let parent;
	try {
		const source = realpathSync(sourceRoot);
		const dest = canonicalDestination(resolve(destination));
		if (contained(source, dest) || contained(dest, source)) throw new Error("snapshot-source-destination-overlap");
		try { lstatSync(dest); throw new Error("snapshot-destination-exists"); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		// 先判定载体排除（根包声明 + 身份校验），再建图：载体在建图阶段就被跳过。
		const carrier = carrierExclusion(source);
		if (!carrier.ok) throw new Error(carrier.error);
		const graph = runWorker(source, "graph", carrier.carrier);
		if (!graph.ok) return graph;
		mkdirSync(dirname(dest), { recursive: true });
		parent = realpathSync(dirname(dest));
		staging = mkdtempSync(join(parent, ".dsh-runtime-snapshot-"));
		copyPayload(join(source, "package.json"), join(staging, "package.json"), copyFile);
		copyPayload(join(source, "lib"), join(staging, "lib"), copyFile);
		const targets = graph.nodes.map((_, id) => id === 0 ? staging : join(staging, "node_modules/.runtime-deps", String(id)));
		for (let id = 1; id < graph.nodes.length; id++) copyPayload(graph.nodes[id].source, targets[id], copyFile);
		for (let id = 0; id < graph.nodes.length; id++) {
			for (const [name, dependencyId] of Object.entries(graph.nodes[id].dependencies)) {
				const link = join(targets[id], "node_modules", name);
				mkdirSync(dirname(link), { recursive: true });
				symlinkSync(relative(dirname(link), targets[dependencyId]), link, "dir");
			}
		}
		const runtime = verifyRuntimeClosure(staging);
		if (!runtime.ok) throw new Error(runtime.error);
		const snapshot = inventory(staging);
		writeFileSync(join(staging, RUNTIME_COMPLETE_MARKER), JSON.stringify({ schema: MARKER_SCHEMA, algorithm: "sha256", ...snapshot }) + "\n", { flag: "wx" });
		// 同一父目录内 rename，一次发布已验证树。绝不先删已有目标。
		try { lstatSync(dest); throw new Error("snapshot-destination-exists"); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		renameSync(staging, dest);
		staging = undefined;
		return { ok: true, dir: dest, digest: snapshot.digest, carrierExcluded: carrier.carrier !== null };
	} catch (error) {
		return { ok: false, error: `snapshot-failed: ${error.message ?? error}` };
	} finally {
		if (staging) cleanupTemporary(staging, parent);
	}
}
