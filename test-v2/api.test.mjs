import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { parseCsv, parseConsentFlag, validPhone, canSendToLead, assertLiveSendDisabled } from '../lib/core-v2.mjs';

test('CSV parser handles BOM, quoted commas and escaped quotes',()=>{
 const a=parseCsv('\uFEFFvk_user_id,phone,source\n123,+79990000000,"group, city"\n124,+79990000001,"said ""yes"""');
 assert.equal(a[0].source,'group, city');assert.equal(a[1].source,'said "yes"');
});
test('CSV parser rejects malformed data',()=>{
 assert.throws(()=>parseCsv('a,b\n"broken,x'),/кавычка/i);
 assert.throws(()=>parseCsv('a,a\n1,2'),/повторяются/i);
});
test('consent parser is tri-state and phone validation is bounded',()=>{
 assert.equal(parseConsentFlag('да'),true);assert.equal(parseConsentFlag('нет'),false);assert.equal(parseConsentFlag('unknown'),null);
 assert.equal(validPhone('+7 (999) 000-00-00'),true);assert.equal(validPhone('123'),false);
});
const eligible={vk_user_id:'123',personal_data_consent:true,personal_data_consent_at:'2026-11-24T10:00:00Z',personal_data_consent_source:'form#pd',advertising_consent:true,advertising_consent_at:'2026-11-24T10:01:00Z',advertising_consent_source:'form#ad',vk_messages_allowed:true,vk_permission_at:'2026-11-24T10:02:00Z',vk_permission_source:'vk-community-start'};
test('all separate documented permissions and VK ID are required',()=>{
 assert.equal(canSendToLead(eligible).ok,true);
 assert.match(canSendToLead({...eligible,advertising_consent:false}).reason,/рекламу/);
 assert.match(canSendToLead({...eligible,vk_messages_allowed:false}).reason,/VK/);
 assert.match(canSendToLead({...eligible,personal_data_consent_source:null}).reason,/персональных данных/);
 assert.match(canSendToLead({...eligible,vk_user_id:null}).reason,/VK ID/);
 assert.equal(canSendToLead({...eligible,unsubscribed:true}).reason,'Отписка');
 assert.equal(canSendToLead({...eligible,suppressed:true}).reason,'Стоп-лист');
});
test('no argument can unlock live VK message delivery',()=>{
 assert.throws(()=>assertLiveSendDisabled(),e=>e.code==='LIVE_SEND_DISABLED'&&e.status===423);
});
test('HTTP API imports audience, simulates campaigns and refuses actual sending',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'vkleadbot-'));
 const probe=net.createServer();probe.listen(0);await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['server-v2.mjs'],{cwd:path.resolve('.'),env:{...process.env,PORT:String(port),DATABASE_PATH:path.join(dir,'test.sqlite'),ADMIN_PASSWORD:'test-password-only'},stdio:'ignore'});
 t.after(async()=>{child.kill('SIGTERM');await once(child,'exit').catch(()=>{});await rm(dir,{recursive:true,force:true});});
 let health;for(let i=0;i<50;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/api/health');if(r.ok){health=await r.json();break;}}catch{}await new Promise(r=>setTimeout(r,200));}
 assert.ok(health?.ok);assert.equal(health.totalOffers,123);assert.equal(health.offersDraft,123);assert.equal(health.liveMessagingEnabled,false);
 const login=await fetch('http://127.0.0.1:'+port+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'test-password-only'})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];const headers={'content-type':'application/json',cookie};
 const good={vk_user_id:'710001',phone:'+79990000001',source:'test',personal_data_consent:'true',personal_data_consent_at:'2026-11-24T10:00:00Z',personal_data_consent_source:'test-form-pd',advertising_consent:'true',advertising_consent_at:'2026-11-24T10:01:00Z',advertising_consent_source:'test-form-ad',vk_messages_allowed:'true',vk_messages_allowed_at:'2026-11-24T10:02:00Z',vk_messages_allowed_source:'vk-start'};
 const bad={vk_user_id:'710002',phone:'+79990000002',source:'test',personal_data_consent:'true',personal_data_consent_at:'2026-11-24T10:00:00Z',personal_data_consent_source:'test-form-pd',advertising_consent:'true',advertising_consent_at:'2026-11-24T10:01:00Z',advertising_consent_source:'test-form-ad',vk_messages_allowed:'false'};
 let r=await fetch('http://127.0.0.1:'+port+'/api/leads/import',{method:'POST',headers,body:JSON.stringify({rows:[good,bad,good]})});assert.equal(r.status,200);const imported=await r.json();assert.equal(imported.imported,2);assert.equal(imported.updated,1);
 r=await fetch('http://127.0.0.1:'+port+'/api/campaigns',{method:'POST',headers,body:JSON.stringify({name:'Test simulation',message:'This is a local test'})});assert.equal(r.status,201);const campaign=await r.json();
 r=await fetch('http://127.0.0.1:'+port+'/api/campaigns/'+campaign.id+'/dry-run',{method:'POST',headers,body:'{}'});assert.equal(r.status,200);const simulation=await r.json();assert.equal(simulation.sent,0);assert.equal(simulation.eligible,1);assert.equal(simulation.skipped,1);
 r=await fetch('http://127.0.0.1:'+port+'/api/campaigns/'+campaign.id+'/send',{method:'POST',headers,body:'{}'});assert.equal(r.status,423);assert.equal((await r.json()).liveMessagingEnabled,false);
 r=await fetch('http://127.0.0.1:'+port+'/api/leads/1/unsubscribe',{method:'POST',headers,body:'{}'});assert.equal(r.status,200);
 r=await fetch('http://127.0.0.1:'+port+'/api/campaigns/'+campaign.id+'/dry-run',{method:'POST',headers,body:'{}'});const after=await r.json();assert.equal(after.eligible,0);assert.equal(after.skipped,2);
});
