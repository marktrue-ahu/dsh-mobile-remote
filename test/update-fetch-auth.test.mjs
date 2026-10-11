import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fetchReleaseManifest, downloadVerified, UPDATE_SOURCE_KIND, resolvePluginUrl } from '../lib/plugin-self-update.js';
import { fetchUpdateResource } from '../lib/update-fetch.js';

test('W1: protected host manifest envelope -> authenticated tgz consumer; external redirect receives no host token',async()=>{
  const origin='http://127.0.0.1:39403', bytes=Buffer.from('fixture-tgz'), token='fixture-only-secret';
  const seen=[];
  const fetchImpl=async(url,options)=>{
    seen.push({url,token:options.headers['x-mobile-token']});
    if(url.startsWith(origin)) assert.equal(options.headers['x-mobile-token'],token);
    else assert.equal(options.headers['x-mobile-token'],undefined);
    if(url.endsWith('/manifest')) return new Response(JSON.stringify({ok:true,manifest:{schema:1,
      plugin:{version:'3.3.0',file:'p.tgz',url:'/m/api/update/plugin',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},
      app:{version:'3.3.0+70',file:'a.apk',sha256:'a'.repeat(64),size:1},
    }}));
    if(url.startsWith(origin)) return new Response(null,{status:302,headers:{location:'https://external.test/p.tgz'}});
    return new Response(bytes);
  };
  const auth={token,trustedOrigin:origin};
  const r=await fetchReleaseManifest({source:{kind:UPDATE_SOURCE_KIND.CUSTOM,url:`${origin}/m/api/update/manifest`},fetchImpl,auth});
  assert.equal(r.ok,true,r.error);
  const destPath=join(mkdtempSync(join(tmpdir(),'auth-download-')),'p.tgz');
  const downloaded=await downloadVerified({url:resolvePluginUrl(r.manifestUrl,r.manifest.plugin),destPath,
    sha256:r.manifest.plugin.sha256,size:bytes.length,fetchImpl,auth});
  assert.equal(downloaded.ok,true,downloaded.error);assert.deepEqual(readFileSync(destPath),bytes);
  assert.equal(seen.length,3);assert.equal(seen[2].token,undefined);
});

test('W1: same hostname on a different origin/path and external sources never get host credentials',async()=>{
  const calls=[];const fetchImpl=async(url,opts)=>{calls.push(opts.headers);return new Response('{}');};
  for(const url of ['https://external.test/manifest.json','http://127.0.0.1:39404/m/api/update/plugin','http://127.0.0.1:39403/other']) {
    await fetchUpdateResource(url,{fetchImpl,token:'fixture-only-secret',trustedOrigin:'http://127.0.0.1:39403'});
  }
  assert.ok(calls.every(h=>h['x-mobile-token']===undefined));
});

test('W1: the real resolver accepts the loopback host source, so the authenticated path is reachable', async () => {
  const { resolveManifestSource } = await import('../lib/plugin-self-update.js');
  const loop = resolveManifestSource('http://127.0.0.1:39403/m/api/update/manifest');
  assert.equal(loop.kind, 'custom');
  assert.equal(loop.loopback, true);
  assert.equal(loop.url, 'http://127.0.0.1:39403/m/api/update/manifest');
  // 外部 http 仍然非法（不放宽），https 与 off/upstream 语义不变
  assert.equal(resolveManifestSource('http://external.test/m.json').kind, 'invalid');
  assert.equal(resolveManifestSource('https://external.test/m.json').kind, 'custom');
  assert.equal(resolveManifestSource('off').kind, 'off');
  assert.equal(resolveManifestSource('upstream').kind, 'upstream');
});
