import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {chromium} from '/home/aegis/cipher/node_modules/playwright-core/index.mjs';
const source=await readFile(new URL('./src/lib/securityContextFence.js',import.meta.url),'utf8');
const server=http.createServer((req,res)=>{if(req.url==='/fence.js'){res.setHeader('content-type','text/javascript');res.end(source);}else{res.setHeader('content-type','text/html');res.end('<title>isolated</title>');}});
server.listen(0,'127.0.0.1');await once(server,'listening');const browser=await chromium.launch({headless:true});const context=await browser.newContext();
try{
 const a=await context.newPage(),b=await context.newPage();await Promise.all([a.goto(`http://127.0.0.1:${server.address().port}`),b.goto(`http://127.0.0.1:${server.address().port}`)]);
 const result=await a.evaluate(async()=>{const m=await import('/fence.js');const c=m.establishSecurityContext({owner:'a'.repeat(64),randomId:()=>crypto.randomUUID()});const ch=new BroadcastChannel('privacy-test');const f=m.createSecurityContextFence({context:c,channel:ch});return {context:c,valid:f.isCurrent()};});
 await b.evaluate(async(c)=>{const m=await import('/fence.js');const ch=new BroadcastChannel('privacy-test');window.peerFence=m.createSecurityContextFence({context:c,channel:ch});},result.context);
 await b.evaluate(async()=>{const m=await import('/fence.js');m.establishSecurityContext({owner:'b'.repeat(64),randomId:()=>crypto.randomUUID()});});
 const invalidation=await a.evaluate(async()=>{const m=await import('/fence.js');return m.invalidateSecurityContext({owner:'a'.repeat(64),channel:new BroadcastChannel('privacy-test')});});
 await a.waitForTimeout(25);
 assert(result.valid);assert(invalidation.persisted);assert.equal(invalidation.invalidated,true);assert.equal(await b.evaluate(()=>Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).some(k=>k?.startsWith('cipher_security_context_v1:'+'b'.repeat(64)+':'))),true);assert.equal(await b.evaluate(()=>window.peerFence.isCurrent()),false);
 console.log(JSON.stringify({twoTabs:true,accountScoped:true,siblingInvalidated:true,invalidation,invalidationMarkerRemoved:true}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
