import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { parseCsv, parseConsentFlag, validPhone, validEvidenceDate, canSendToLead, assertLiveSendDisabled } from '../lib/core-v2.mjs';

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
 assert.equal(validPhone('+7 (999) 000-00-00'),true);assert.equal(validPhone('123'),false);assert.equal(validEvidenceDate('not-a-date'),false);assert.equal(validEvidenceDate('2026-11-24T10:00:00Z'),true);
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
 const child=spawn(process.execPath,['server-v2.mjs'],{cwd:path.resolve('.'),env:{...process.env,PORT:String(port),DATABASE_PATH:path.join(dir,'test.sqlite'),ADMIN_PASSWORD:'test-password-only',VK_COMMUNITY_ID:'243658195',VK_CALLBACK_CONFIRMATION:'ci-confirmation-token',VK_CALLBACK_SECRET:'ci-callback-secret'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',d=>output+=d.toString());child.stderr.on('data',d=>output+=d.toString());
 t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit').catch(()=>{});await rm(dir,{recursive:true,force:true});});
 let health;for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/api/health');if(r.ok){health=await r.json();break;}}catch{}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,250));}
 assert.ok(health?.ok,'Server did not start. Output: '+output);
 assert.equal(health.totalOffers,123);assert.equal(health.offersDraft,123);assert.equal(health.liveMessagingEnabled,false);assert.equal(health.showcaseTotal,129);assert.equal(health.showcaseImport,129);
 const showcasePage=await fetch('http://127.0.0.1:'+port+'/showcase');assert.equal(showcasePage.status,200);assert.match(await showcasePage.text(),/Оценивайте свои финансовые возможности и риски/);
 const publicShowcaseResponse=await fetch('http://127.0.0.1:'+port+'/api/public/showcase');assert.equal(publicShowcaseResponse.status,200);const publicShowcase=await publicShowcaseResponse.json();assert.equal(publicShowcase.total,128);assert.equal(publicShowcase.excluded,1);assert.equal(publicShowcase.publicationEnabled,false);assert.ok(!publicShowcase.offers.some(x=>x.code==='2110'));assert.ok(publicShowcase.offers.every(x=>x.clickEnabled===false));assert.ok(!JSON.stringify(publicShowcase).includes('bit-do.ru'));
 let cb=await fetch('http://127.0.0.1:'+port+'/api/vk/callback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'confirmation',group_id:243658195,secret:'wrong'})});assert.equal(cb.status,403);
 cb=await fetch('http://127.0.0.1:'+port+'/api/vk/callback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'confirmation',group_id:243658195,secret:'ci-callback-secret'})});assert.equal(cb.status,200);assert.equal(await cb.text(),'ci-confirmation-token');
 const incoming={type:'message_new',group_id:243658195,event_id:'event-test-001',secret:'ci-callback-secret',object:{message:{id:77,from_id:710055,peer_id:710055,text:'test'}}};
 cb=await fetch('http://127.0.0.1:'+port+'/api/vk/callback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(incoming)});assert.equal(cb.status,200);assert.equal(await cb.text(),'ok');
 cb=await fetch('http://127.0.0.1:'+port+'/api/vk/callback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(incoming)});assert.equal(cb.status,200);
 const home=await fetch('http://127.0.0.1:'+port+'/');assert.equal(home.status,200);assert.match(await home.text(),/VK LeadBot/);
 const guest=await fetch('http://127.0.0.1:'+port+'/api/leads');assert.equal(guest.status,401);
 const login=await fetch('http://127.0.0.1:'+port+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'test-password-only'})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];const headers={'content-type':'application/json',cookie};
 const showcaseSummaryResponse=await fetch('http://127.0.0.1:'+port+'/api/showcase/summary',{headers});assert.equal(showcaseSummaryResponse.status,200);const showcaseSummary=await showcaseSummaryResponse.json();assert.equal(showcaseSummary.total,129);assert.equal(showcaseSummary.readyForReview,128);assert.equal(showcaseSummary.excluded,1);assert.equal(showcaseSummary.withErid,32);assert.equal(showcaseSummary.withoutErid,95);assert.equal(showcaseSummary.staticErid,2);
 const unauthEvents=await fetch('http://127.0.0.1:'+port+'/api/vk/events');assert.equal(unauthEvents.status,401);
 const authEvents=await fetch('http://127.0.0.1:'+port+'/api/vk/events',{headers});assert.equal(authEvents.status,200);const vkEvents=await authEvents.json();assert.equal(vkEvents.total,1);assert.equal(vkEvents.events[0].event_type,'message_new');assert.equal(vkEvents.events[0].vk_user_id,'710055');
 let r=await fetch('http://127.0.0.1:'+port+'/api/offers',{headers});assert.equal(r.status,200);const catalog=await r.json();assert.equal(catalog.offers.length,123);assert.ok(catalog.offers.every(o=>o.status==='draft'&&o.bot_enabled===false));
 const offerCode=catalog.offers[0].source_offer_code;r=await fetch('http://127.0.0.1:'+port+'/api/offers/'+offerCode,{method:'PATCH',headers,body:JSON.stringify({status:'active',bot_enabled:true})});assert.equal(r.status,200);assert.equal((await r.json()).offer.status,'draft');
 const good={vk_user_id:'710001',phone:'+79990000001',source:'test',personal_data_consent:'true',personal_data_consent_at:'2026-11-24T10:00:00Z',personal_data_consent_source:'test-form-pd',advertising_consent:'true',advertising_consent_at:'2026-11-24T10:01:00Z',advertising_consent_source:'test-form-ad',vk_messages_allowed:'true',vk_messages_allowed_at:'2026-11-24T10:02:00Z',vk_messages_allowed_source:'vk-start'};
 const bad={vk_user_id:'710002',phone:'+79990000002',source:'test',personal_data_consent:'true',personal_data_consent_at:'2026-11-24T10:00:00Z',personal_data_consent_source:'test-form-pd',advertising_consent:'true',advertising_consent_at:'2026-11-24T10:01:00Z',advertising_consent_source:'test-form-ad',vk_messages_allowed:'false'};
 r=await fetch('http://127.0.0.1:'+port+'/api/leads/import',{method:'POST',headers,body:JSON.stringify({rows:[good,bad,good]})});assert.equal(r.status,200);const imported=await r.json();assert.equal(imported.imported,2);assert.equal(imported.updated,1);
 r=await fetch('http://127.0.0.1:'+port+'/api/campaigns',{method:'POST',headers,body:JSON.stringify({name:'Test simulation',message:'This is a local test'})});assert.equal(r.status,201);const campaign=await r.json();
 r=await fetch('http://127.0.0.1:'+port+'/api/campaigns/'+campaign.id+'/dry-run',{method:'POST',headers,body:'{}'});assert.equal(r.status,200);const simulation=await r.json();assert.equal(simulation.sent,0);assert.equal(simulation.eligible,1);assert.equal(simulation.skipped,1);
 r=await fetch('http://127.0.0.1:'+port+'/api/campaigns/'+campaign.id+'/send',{method:'POST',headers,body:'{}'});assert.equal(r.status,423);assert.equal((await r.json()).liveMessagingEnabled,false);
 r=await fetch('http://127.0.0.1:'+port+'/api/leads/1/unsubscribe',{method:'POST',headers,body:'{}'});assert.equal(r.status,200);
 r=await fetch('http://127.0.0.1:'+port+'/api/leads/1/unsubscribe',{method:'POST',headers,body:'{}'});assert.equal(r.status,200);
 r=await fetch('http://127.0.0.1:'+port+'/api/campaigns/'+campaign.id+'/dry-run',{method:'POST',headers,body:'{}'});const after=await r.json();assert.equal(after.eligible,0);assert.equal(after.skipped,2);
});
