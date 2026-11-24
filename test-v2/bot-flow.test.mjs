import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function listen(server){
 return new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>resolve(server.address().port));
 });
}
async function freePort(){
 const s=net.createServer();const port=await listen(s);await new Promise(r=>s.close(r));return port;
}
async function postJson(url,body,headers={}){
 return fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
}

test('VK bot replies to an incoming request, captures phone and sends four reviewed offers plus showcase',async t=>{
 const calls=[];
 const mockVk=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  calls.push(new URLSearchParams(body));
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({response:1000+calls.length}));
 });
 const mockPort=await listen(mockVk);
 const dir=await mkdtemp(path.join(os.tmpdir(),'vkleadbot-flow-'));
 const port=await freePort();
 const child=spawn(process.execPath,['server-v2.mjs'],{
  cwd:path.resolve('.'),
  env:{...process.env,PORT:String(port),DATABASE_PATH:path.join(dir,'test.sqlite'),
   ADMIN_PASSWORD:'ci-test-password',VK_COMMUNITY_ID:'243658195',
   VK_CALLBACK_CONFIRMATION:'ci-confirmation',VK_CALLBACK_SECRET:'ci-secret',
   VK_ACCESS_TOKEN:'ci-only-vk-token',VK_BOT_REPLIES_ENABLED:'true',
   VK_API_BASE_URL:'http://127.0.0.1:'+mockPort+'/method/messages.send',
   PUBLIC_BASE_URL:'https://bot.example.test'},
  stdio:['ignore','pipe','pipe']
 });
 let logs='';child.stdout.on('data',d=>logs+=d.toString());child.stderr.on('data',d=>logs+=d.toString());
 t.after(async()=>{
  if(child.exitCode===null)child.kill('SIGTERM');
  if(child.exitCode===null)await once(child,'exit').catch(()=>{});
  await rm(dir,{recursive:true,force:true});
  await new Promise(r=>mockVk.close(r));
 });
 let health;
 for(let i=0;i<80;i++){
  try{const r=await fetch('http://127.0.0.1:'+port+'/api/health');if(r.ok){health=await r.json();break;}}catch{}
  if(child.exitCode!==null)break;
  await new Promise(r=>setTimeout(r,150));
 }
 assert.ok(health?.ok,'server did not start: '+logs);
 assert.equal(health.botReplyEnabled,true);
 const callback='http://127.0.0.1:'+port+'/api/vk/callback';
 async function message(eventId,id,text,payload){
  return postJson(callback,{type:'message_new',group_id:243658195,event_id:eventId,secret:'ci-secret',
   object:{message:{id,from_id:770001,peer_id:770001,text,...(payload?{payload}: {})}}});
 }
 let response=await message('bot-flow-1',1,'Привет');
 assert.equal(response.status,200);assert.equal(await response.text(),'ok');
 assert.equal(calls.length,1);
 assert.match(calls[0].get('message'),/Здравствуйте/);
 const greetingKeyboard=JSON.parse(calls[0].get('keyboard'));
 assert.equal(greetingKeyboard.buttons[0][0].action.label,'Получить предложения');

 response=await message('bot-flow-2',2,'Получить предложения');
 assert.equal(response.status,200);assert.equal(calls.length,2);
 assert.match(calls[1].get('message'),/отправьте номер телефона/i);
 assert.match(calls[1].get('message'),/партнёрам/i);

 const login=await postJson('http://127.0.0.1:'+port+'/api/login',{password:'ci-test-password'});
 assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const headers={cookie};
 const list=await fetch('http://127.0.0.1:'+port+'/api/showcase/links',{headers});
 assert.equal(list.status,200);
 const catalog=await list.json();
 const approvable=catalog.links.filter(x=>x.erid&&x.erid!=='static').slice(0,4);
 assert.equal(approvable.length,4);
 for(const offer of approvable){
  const saved=await fetch('http://127.0.0.1:'+port+'/api/showcase/links/'+offer.source_offer_code,{
   method:'PATCH',headers:{...headers,'content-type':'application/json'},
   body:JSON.stringify({advertiser_name:'Тестовый рекламодатель '+offer.source_offer_code,
    advertiser_site:'https://example.test/advertiser',erid:offer.erid,erid_verified:true,
    terms_verified:true,publication_enabled:true})
  });
  assert.equal(saved.status,200);
  assert.equal((await saved.json()).publicationEnabled,true);
 }
 response=await message('bot-flow-3',3,'+7 (999) 123-45-67');
 assert.equal(response.status,200);assert.equal(calls.length,3);
 const reply=calls[2].get('message');
 for(const offer of approvable){assert.ok(reply.includes(offer.label));assert.ok(reply.includes(offer.erid));}
 assert.match(reply,/Реклама\./);
 const keyboard=JSON.parse(calls[2].get('keyboard'));
 assert.equal(keyboard.buttons.length,5);
 for(let i=0;i<approvable.length;i++)assert.equal(keyboard.buttons[i][0].action.link,approvable[i].cpa_url);
 assert.equal(keyboard.buttons[4][0].action.label,'Все предложения');
 assert.equal(keyboard.buttons[4][0].action.link,'https://bot.example.test/showcase');

 const duplicate=await message('bot-flow-3',3,'+7 (999) 123-45-67');
 assert.equal(duplicate.status,200);
 assert.equal(calls.length,3,'duplicate Callback event must not send a second reply');

 const leads=await fetch('http://127.0.0.1:'+port+'/api/leads',{headers});
 assert.equal(leads.status,200);
 const leadData=await leads.json();
 assert.equal(leadData.leads.length,1);
 assert.equal(leadData.leads[0].vk_user_id,'770001');
 assert.equal(leadData.leads[0].phone,'+79991234567');
 assert.equal(leadData.leads[0].source,'vk-requested-offer');

 const publicShowcase=await fetch('http://127.0.0.1:'+port+'/api/public/showcase');
 const publicData=await publicShowcase.json();
 assert.equal(publicData.enabled,4);
 assert.equal(publicData.offers.filter(x=>x.clickEnabled).length,4);
});
