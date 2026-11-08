// issue #60 R15：宿主稳定身份（bootstrap plugin.hostId）与测试注入的持久化/原子发布。

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, utimesSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { apply, hostIdentityFile, resolveHostIdentity } from "../lib/index.js";

const CONFIG = {
	path: "/m",
	authToken: "1234567890123456",
	cookieName: "dsh_mobile_token",
	trustedHosts: [],
	sessionTtlMs: 60_000,
	rechargeUrl: "https://example.test/top-up",
	maxConnections: 4,
	pushUrls: [],
	pushCooldownMs: 1,
	doneGraceMs: 1,
	pushContent: "minimal",
	rateLimit: {},
	lanBridge: { enabled: false, port: 3080, host: "127.0.0.1" },
	approvalMode: "both",
};

class FakeResponse extends EventEmitter {
	constructor() {
		super();
		this.headersSent = false;
		this.chunks = [];
	}
	writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; }
	write(chunk) { this.chunks.push(Buffer.from(String(chunk))); return true; }
	end(chunk = "") { if (chunk !== "") this.write(chunk); this.emit("finish"); }
	destroy() { this.emit("close"); }
}

class FakeRequest extends EventEmitter {
	constructor(url) {
		super();
		this.url = url;
		this.method = "GET";
		this.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken };
		this.socket = { remoteAddress: "127.0.0.1" };
	}
}

function harness(home) {
	const routes = [];
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43120, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {} },
		get() { return undefined; },
		provide() {},
		on() { return () => {}; },
		effect(callback) { const dispose = callback?.(); return typeof dispose === "function" ? dispose : () => {}; },
		inject() {},
		waterfall: async () => "unavailable",
	};
	const dispose = apply(ctx, CONFIG);
	return {
		route: routes.find((route) => route.path === "/m/api").handler,
		clean() { dispose?.(); process.env.HOME = previousHome; },
	};
}

async function bootstrap(route) {
	const req = new FakeRequest("/m/api/bootstrap");
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await finished;
	return JSON.parse(Buffer.concat(res.chunks).toString("utf8"));
}


test("稳定身份：首次发布、重启读取及不同状态目录隔离", () => {
 const a=mkdtempSync(join(tmpdir(),"identity-a-")); const b=mkdtempSync(join(tmpdir(),"identity-b-"));
 const id=resolveHostIdentity({home:a}); assert.match(id,/^[0-9a-f-]{36}$/i);
 assert.equal(resolveHostIdentity({home:a}),id); assert.notEqual(resolveHostIdentity({home:b}),id);
 assert.equal(readFileSync(hostIdentityFile(a),"utf8").trim(),id);
});

test("bootstrap 暴露持久身份而非实例身份", async () => {
 const home=mkdtempSync(join(tmpdir(),"identity-bootstrap-"));
 const a=harness(home); const first=await bootstrap(a.route); a.clean();
 const b=harness(home); const second=await bootstrap(b.route); b.clean();
 assert.match(first.plugin.hostId,/^[0-9a-f-]{36}$/i);
 assert.notEqual(first.plugin.hostId,first.plugin.instanceId); assert.equal(second.plugin.hostId,first.plugin.hostId);
});

async function runCreators(home,count) {
 const url=pathToFileURL(new URL("../lib/index.js",import.meta.url).pathname).href;
 return Promise.all(Array.from({length:count},()=>new Promise((ok,bad)=>{
  const child=spawn(process.execPath,["--input-type=module","-e",`const m=await import(process.env.URL); process.stdout.write(m.resolveHostIdentity({home:process.env.TEST_HOME}));`],{env:{...process.env,URL:url,TEST_HOME:home},stdio:["ignore","pipe","pipe"]});
  let out="",err=""; child.stdout.on("data",x=>out+=x); child.stderr.on("data",x=>err+=x); child.on("error",bad);child.on("close",code=>code===0?ok(out.trim()):bad(new Error(err)));
 })));
}

test("并发首次创建只发布一个完整身份",async()=>{
 const home=mkdtempSync(join(tmpdir(),"identity-race-"));const ids=await runCreators(home,8);
 assert.equal(new Set(ids).size,1);assert.equal(readFileSync(hostIdentityFile(home),"utf8").trim(),ids[0]);
});

test("私有候选暂停时另一生产进程可发布，恢复后原候选读取赢家",()=>{
 const home=mkdtempSync(join(tmpdir(),"identity-pause-"));const url=pathToFileURL(new URL("../lib/index.js",import.meta.url).pathname).href;let winner;
 const id=resolveHostIdentity({home,onBeforePublish:()=>{
  const child=spawnSync(process.execPath,["--input-type=module","-e",`const m=await import(process.env.URL);process.stdout.write(m.resolveHostIdentity({home:process.env.TEST_HOME}));`],{encoding:"utf8",env:{...process.env,URL:url,TEST_HOME:home},timeout:15000});
  assert.equal(child.status,0,child.stderr);winner=child.stdout.trim();
 }});
 assert.equal(id,winner);assert.equal(readFileSync(hostIdentityFile(home),"utf8").trim(),winner);
 assert.deepEqual(readdirSync(join(home,".dsh","mobile-remote")).filter(n=>n.includes(".candidate.")),[]);
});

test("旧版空/损坏占位即使陈旧也不自动删除或覆盖",()=>{
 for (const contents of ["", "corrupt"]) {
  const home=mkdtempSync(join(tmpdir(),"identity-invalid-"));const file=hostIdentityFile(home);mkdirSync(join(home,".dsh","mobile-remote"),{recursive:true});writeFileSync(file,contents);const old=new Date(Date.now()-10000);utimesSync(file,old,old);
  assert.throws(()=>resolveHostIdentity({home}),e=>e.code==="HOST_IDENTITY_LOCK_UNAVAILABLE");
  assert.equal(readFileSync(file,"utf8"),contents);
  assert.deepEqual(readdirSync(join(home,".dsh","mobile-remote")).filter(n=>n.includes(".candidate.")),[]);
 }
});

test("身份损坏时插件不把临时 UUID 冒充稳定 hostId",()=>{
 const home=mkdtempSync(join(tmpdir(),"identity-refuse-"));const file=hostIdentityFile(home);mkdirSync(join(home,".dsh","mobile-remote"),{recursive:true});writeFileSync(file,"");const previous=process.env.HOME;
 try {assert.throws(()=>harness(home),e=>e.code==="HOST_IDENTITY_LOCK_UNAVAILABLE");assert.equal(readFileSync(file,"utf8"),"");} finally {process.env.HOME=previous;}
});

test("候选发布前失败不创建共享身份且只清理自身候选",()=>{
 const home=mkdtempSync(join(tmpdir(),"identity-fail-"));
 assert.throws(()=>resolveHostIdentity({home,onBeforePublish:()=>{throw Error("synthetic failure");}}),e=>e.code==="HOST_IDENTITY_STORAGE_UNAVAILABLE");
 assert.equal(existsSync(hostIdentityFile(home)),false);
 assert.deepEqual(readdirSync(join(home,".dsh","mobile-remote")).filter(n=>n.includes(".candidate.")),[]);
});

test("候选文件创建后进程崩溃不会阻塞下一进程原子发布",()=>{
 const home=mkdtempSync(join(tmpdir(),"identity-crash-"));
 const url=pathToFileURL(new URL("../lib/index.js",import.meta.url).pathname).href;
 const child=spawnSync(process.execPath,["--input-type=module","-e",`const m=await import(process.env.URL);m.resolveHostIdentity({home:process.env.TEST_HOME,onBeforePublish:()=>process.exit(0)});`],{encoding:"utf8",env:{...process.env,URL:url,TEST_HOME:home},timeout:15000});
 assert.equal(child.status,0,child.stderr);assert.equal(existsSync(hostIdentityFile(home)),false);
 const winner=resolveHostIdentity({home});assert.match(winner,/^[0-9a-f-]{36}$/i);
 assert.equal(readFileSync(hostIdentityFile(home),"utf8").trim(),winner);
});

test("旧版写入者持有空占位时等待已发布值，不删除占位", async () => {
 const home=mkdtempSync(join(tmpdir(),"identity-legacy-")); const file=hostIdentityFile(home);
 mkdirSync(join(home,".dsh","mobile-remote"),{recursive:true});
 const id="77777777-7777-4777-8777-777777777777";
 const code=`const fs=require('node:fs'); const fd=fs.openSync(process.env.FILE,'wx',0o600);setTimeout(()=>{fs.writeSync(fd,process.env.ID+'\\n');fs.closeSync(fd)},200)`;
 const child=spawn(process.execPath,["-e",code],{env:{...process.env,FILE:file,ID:id},stdio:"ignore"});
 const done=new Promise(ok=>child.on("close",ok));
 const end=Date.now()+5000; while(!existsSync(file)&&Date.now()<end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
 assert.equal(existsSync(file),true);assert.equal(resolveHostIdentity({home}),id);
 assert.equal(await done,0);assert.equal(readFileSync(file,"utf8").trim(),id);
});

test("文件系统不支持 hard link 时返回存储错误，不伪造身份",()=>{
 const home=mkdtempSync(join(tmpdir(),"identity-nolink-"));const url=pathToFileURL(new URL("../lib/index.js",import.meta.url).pathname).href;
 const code=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';fs.linkSync=()=>{throw Object.assign(Error('private path'),{code:'EPERM'})};syncBuiltinESMExports();const m=await import(process.env.URL);try{m.resolveHostIdentity({home:process.env.TEST_HOME});process.exit(3)}catch(e){process.stdout.write(e.code+':'+e.message)}`;
 const result=spawnSync(process.execPath,["--input-type=module","-e",code],{encoding:"utf8",env:{...process.env,URL:url,TEST_HOME:home},timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/HOST_IDENTITY_STORAGE_UNAVAILABLE/);assert.doesNotMatch(result.stdout,/private path/);assert.equal(existsSync(hostIdentityFile(home)),false);
});
