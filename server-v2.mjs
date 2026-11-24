import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { canSendToLead, parseConsentFlag, validPhone, validEvidenceDate, assertLiveSendDisabled } from './lib/core-v2.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url)), DATA=path.resolve(ROOT,'.data');
fs.mkdirSync(DATA,{recursive:true});
const DBPATH=path.resolve(ROOT,process.env.DATABASE_PATH||'.data/vkleadbot-v2.sqlite');
fs.mkdirSync(path.dirname(DBPATH),{recursive:true});
const db=new DatabaseSync(DBPATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec([
'CREATE TABLE IF NOT EXISTS offers(source_offer_code TEXT PRIMARY KEY,supplied_label TEXT NOT NULL,official_brand TEXT,organization_type TEXT,official_site TEXT,logo_url TEXT,card_image_url TEXT,public_json TEXT NOT NULL,cpa_url TEXT,erid TEXT,internal_note TEXT,status TEXT NOT NULL DEFAULT \'draft\',bot_enabled INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY AUTOINCREMENT,vk_user_id TEXT UNIQUE,phone TEXT UNIQUE,source TEXT,personal_data_consent INTEGER NOT NULL DEFAULT 0,personal_data_consent_at TEXT,personal_data_consent_source TEXT,advertising_consent INTEGER NOT NULL DEFAULT 0,advertising_consent_at TEXT,advertising_consent_source TEXT,vk_messages_allowed INTEGER NOT NULL DEFAULT 0,vk_permission_at TEXT,vk_permission_source TEXT,unsubscribed INTEGER NOT NULL DEFAULT 0,suppressed INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS consent_events(id INTEGER PRIMARY KEY AUTOINCREMENT,lead_id INTEGER NOT NULL,consent_type TEXT NOT NULL,granted INTEGER NOT NULL,occurred_at TEXT NOT NULL,evidence_source TEXT NOT NULL,FOREIGN KEY(lead_id) REFERENCES leads(id))',
'CREATE TABLE IF NOT EXISTS campaigns(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'draft\',created_at TEXT NOT NULL,simulated_at TEXT,eligible_count INTEGER NOT NULL DEFAULT 0,skipped_count INTEGER NOT NULL DEFAULT 0)',
'CREATE TABLE IF NOT EXISTS campaign_recipients(id INTEGER PRIMARY KEY AUTOINCREMENT,campaign_id INTEGER NOT NULL,lead_id INTEGER NOT NULL,decision TEXT NOT NULL,reason TEXT,simulated_at TEXT NOT NULL,FOREIGN KEY(campaign_id) REFERENCES campaigns(id),FOREIGN KEY(lead_id) REFERENCES leads(id))',
'CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,url TEXT,source_type TEXT NOT NULL DEFAULT \'manual\',notes TEXT,created_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS bot_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS suppression_list(id INTEGER PRIMARY KEY AUTOINCREMENT,vk_user_id TEXT,phone TEXT,reason TEXT NOT NULL,added_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS vk_inbound_events(event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,vk_user_id TEXT,message_id TEXT,peer_id TEXT,received_at TEXT NOT NULL)'
].join(';\n') + ';');
db.exec('CREATE INDEX IF NOT EXISTS idx_lead_eligibility ON leads(advertising_consent,vk_messages_allowed,unsubscribed,suppressed); CREATE INDEX IF NOT EXISTS idx_campaign_recipient ON campaign_recipients(campaign_id);');
const now=()=>new Date().toISOString(), sessions=new Map(), attempts=new Map();
const DEFAULT={bot:{greeting:'Здравствуйте! Поможем ознакомиться с доступными предложениями. Мы не являемся кредитором и не гарантируем одобрение.',explanation:'Вы можете отдельно согласиться на обработку данных и получение рекламных предложений. Согласие на рекламу добровольное.',personalDataConsent:'Я согласен(на) на обработку персональных данных согласно политике конфиденциальности.',advertisingConsent:'Я отдельно согласен(на) получать рекламные сообщения. Согласие можно отозвать в любое время.',phonePrompt:'Укажите номер телефона для обратной связи.',offersIntro:'Ниже представлены предложения. Изучите условия на сайте поставщика.',support:'По вопросам работы сервиса обратитесь в поддержку.'},privacyUrl:'',supportUrl:'',vkGroupUrl:'',integrations:{vkCommunityId:'',vkApiConnected:false,callbackSecretConfigured:false},liveMessagingEnabled:false};
function run(sql,...p){return db.prepare(sql).run(...p)} function get(sql,...p){return db.prepare(sql).get(...p)} function many(sql,...p){return db.prepare(sql).all(...p)}
function send(res,status,data,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(data));}
function parseCookies(req){const o={};for(const x of (req.headers.cookie||'').split(';')){const i=x.indexOf('=');if(i>0)o[x.slice(0,i).trim()]=decodeURIComponent(x.slice(i+1).trim());}return o;}
function same(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function originOk(req){if(!req.headers.origin)return true;try{return new URL(req.headers.origin).host===req.headers.host;}catch{return false;}}
async function readBody(req,limit=1000000){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>limit)throw Object.assign(new Error('Слишком большой запрос'),{status:413});chunks.push(c);}const raw=Buffer.concat(chunks).toString('utf8');if(!raw)return {};try{return JSON.parse(raw);}catch{throw Object.assign(new Error('Некорректный JSON'),{status:400});}}
const str=(v,n=2000)=>typeof v==='string'?v.trim().slice(0,n):'';
function auth(req,res){const token=parseCookies(req).vk_leadbot_session,s=token&&sessions.get(token);if(!s||s.expires<Date.now()){if(token)sessions.delete(token);send(res,401,{error:'Требуется вход администратора'});return false;}s.expires=Date.now()+43200000;return true;}
const offerJson=r=>({...r,public_terms:JSON.parse(r.public_json||'{}'),status:'draft',bot_enabled:false});
let bootImport=0;
function importCatalog(){
 const op=path.join(ROOT,'research/official-offer-enrichment-2026-11-22.json'),ap=path.join(ROOT,'research/official-brand-assets-2026-11-22.json');
 if(!fs.existsSync(op))return 0;
 const data=JSON.parse(fs.readFileSync(op,'utf8')),assets=fs.existsSync(ap)?JSON.parse(fs.readFileSync(ap,'utf8')).assets||[]:[],map=new Map(assets.map(a=>[String(a.code),a]));
 const up=db.prepare('INSERT INTO offers(source_offer_code,supplied_label,official_brand,organization_type,official_site,logo_url,card_image_url,public_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_offer_code) DO UPDATE SET supplied_label=excluded.supplied_label,official_brand=excluded.official_brand,organization_type=excluded.organization_type,official_site=excluded.official_site,logo_url=COALESCE(excluded.logo_url,offers.logo_url),card_image_url=COALESCE(excluded.card_image_url,offers.card_image_url),public_json=excluded.public_json,updated_at=excluded.updated_at');
 for(const r of data.records||[]){const a=map.get(String(r.source_offer_code))||{};up.run(String(r.source_offer_code),r.supplied_label||String(r.source_offer_code),r.official_brand||null,r.organization_type||null,r.official_site||a.site||null,r.logo_url||a.logo||a.og||null,r.card_image_url||a.card||null,JSON.stringify(r),now());}
 return (data.records||[]).length;
}
bootImport=importCatalog();
function settings(){const r=get('SELECT value_json FROM bot_settings WHERE key=?','main');return r?JSON.parse(r.value_json):DEFAULT;}
function saveSettings(v){run('INSERT INTO bot_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at','main',JSON.stringify(v),now());}
function leadView(l){return {id:l.id,vk_user_id:l.vk_user_id,phone:l.phone,source:l.source,personal_data_consent:!!l.personal_data_consent,personal_data_consent_at:l.personal_data_consent_at,personal_data_consent_source:l.personal_data_consent_source,advertising_consent:!!l.advertising_consent,advertising_consent_at:l.advertising_consent_at,advertising_consent_source:l.advertising_consent_source,vk_messages_allowed:!!l.vk_messages_allowed,vk_permission_at:l.vk_permission_at,vk_permission_source:l.vk_permission_source,unsubscribed:!!l.unsubscribed,suppressed:!!l.suppressed,eligible:canSendToLead(l).ok};}
function withSuppression(){return many('SELECT l.*,CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS in_suppression FROM leads l LEFT JOIN suppression_list s ON (s.vk_user_id=l.vk_user_id AND l.vk_user_id IS NOT NULL) OR (s.phone=l.phone AND l.phone IS NOT NULL)');}
function eligibility(){return withSuppression().map(l=>{const x=canSendToLead({...l,suppressed:!!l.suppressed||!!l.in_suppression});return {lead:l,ok:x.ok,reason:x.reason};});}
function event(id,type,granted,at,source){run('INSERT INTO consent_events(lead_id,consent_type,granted,occurred_at,evidence_source) VALUES(?,?,?,?,?)',id,type,granted?1:0,at,source);}
function importLead(v){
 const vk=str(v.vk_user_id,64)||null,phone=str(v.phone,40).replace(/[\s()\-]/g,'')||null;
 if(!vk&&!phone)return {skip:'Нет VK ID или телефона'};if(phone&&!validPhone(phone))return {skip:'Некорректный телефон'};
 const old=get('SELECT * FROM leads WHERE (? IS NOT NULL AND vk_user_id=?) OR (? IS NOT NULL AND phone=?) LIMIT 1',vk,vk,phone,phone);
 const at=now(),source=str(v.source,500)||'manual-import';
 const proof=p=>({flag:parseConsentFlag(v[p]),at:str(v[p+'_at'],100),source:str(v[p+'_source'],1000)});
 const pd=proof('personal_data_consent'),ad=proof('advertising_consent'),perm=proof('vk_messages_allowed');
 const confirmed=p=>p.flag===true&&validEvidenceDate(p.at)&&p.source;
 const val=(p,k)=>p.flag===null?(old?old[k]:0):(confirmed(p)?1:0);
 const field=(p,kAt,kSource)=>p.flag===null?{at:old?.[kAt]||null,source:old?.[kSource]||null}:confirmed(p)?{at:p.at,source:p.source}:{at:null,source:null};
 const pde=field(pd,'personal_data_consent_at','personal_data_consent_source'),ade=field(ad,'advertising_consent_at','advertising_consent_source'),pe=field(perm,'vk_permission_at','vk_permission_source');
 let id;
 if(old){id=old.id;run('UPDATE leads SET vk_user_id=COALESCE(?,vk_user_id),phone=COALESCE(?,phone),source=?,personal_data_consent=?,personal_data_consent_at=?,personal_data_consent_source=?,advertising_consent=?,advertising_consent_at=?,advertising_consent_source=?,vk_messages_allowed=?,vk_permission_at=?,vk_permission_source=?,updated_at=? WHERE id=?',vk,phone,source,val(pd,'personal_data_consent'),pde.at,pde.source,val(ad,'advertising_consent'),ade.at,ade.source,val(perm,'vk_messages_allowed'),pe.at,pe.source,at,id);}
 else{const r=run('INSERT INTO leads(vk_user_id,phone,source,personal_data_consent,personal_data_consent_at,personal_data_consent_source,advertising_consent,advertising_consent_at,advertising_consent_source,vk_messages_allowed,vk_permission_at,vk_permission_source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',vk,phone,source,val(pd,'personal_data_consent'),pde.at,pde.source,val(ad,'advertising_consent'),ade.at,ade.source,val(perm,'vk_messages_allowed'),pe.at,pe.source,at,at);id=Number(r.lastInsertRowid);}
 for(const [type,p,flag] of [['personal_data',pd,val(pd,'personal_data_consent')],['advertising',ad,val(ad,'advertising_consent')],['vk_messages',perm,val(perm,'vk_messages_allowed')]])if(p.flag===false)event(id,type,false,at,p.source||'explicit-opt-out');else if(p.flag===true&&flag&&confirmed(p))event(id,type,true,p.at,p.source);
 return {id,updated:!!old};
}
async function route(req,res){
 const u=new URL(req.url,'http://'+(req.headers.host||'localhost')),p=u.pathname;
 if(req.method==='GET'&&p==='/api/health')return send(res,200,{ok:true,totalOffers:Number(get('SELECT COUNT(*) n FROM offers').n),offersDraft:Number(get('SELECT COUNT(*) n FROM offers WHERE status=\'draft\' AND bot_enabled=0').n),bootImport,liveMessagingEnabled:false,vkCommunityId:String(process.env.VK_COMMUNITY_ID||'243658195'),vkCallbackConfigured:Boolean(process.env.VK_CALLBACK_CONFIRMATION&&process.env.VK_CALLBACK_SECRET)});
 if(req.method==='POST'&&p==='/api/login'){
  const ip=req.socket.remoteAddress||'unknown',a=attempts.get(ip)||{n:0,until:0};if(a.until>Date.now())return send(res,429,{error:'Слишком много попыток'});
  const d=await readBody(req,20000),password=process.env.ADMIN_PASSWORD||'';
  if(!password||!same(d.password,password)){a.n++;if(a.n>=8){a.n=0;a.until=Date.now()+900000;}attempts.set(ip,a);return send(res,password?401:503,{error:password?'Неверный пароль':'Установите ADMIN_PASSWORD в Secrets'});}
  attempts.delete(ip);const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{expires:Date.now()+43200000});
  return send(res,200,{ok:true},{'set-cookie':'vk_leadbot_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+(process.env.NODE_ENV==='production'?'; Secure':'')});
 }
 if(req.method==='POST'&&p==='/api/logout'){const t=parseCookies(req).vk_leadbot_session;if(t)sessions.delete(t);return send(res,200,{ok:true},{'set-cookie':'vk_leadbot_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
 if(req.method==='POST'&&p==='/api/vk/callback'){
  const d=await readBody(req,200000),groupId=Number(d.group_id),expectedGroup=Number(process.env.VK_COMMUNITY_ID||'243658195'),expectedSecret=process.env.VK_CALLBACK_SECRET||'';
  if(!Number.isSafeInteger(groupId)||groupId!==expectedGroup)return send(res,403,{error:'Неверный ID сообщества'});
  if(!expectedSecret||!same(d.secret,expectedSecret))return send(res,403,{error:'Неверный секрет Callback API'});
  if(d.type==='confirmation'){
   const confirmation=process.env.VK_CALLBACK_CONFIRMATION||'';
   if(!confirmation)return send(res,503,{error:'Не задан VK_CALLBACK_CONFIRMATION'});
   res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end(confirmation);return;
  }
  const type=str(d.type,80),o=d.object&&typeof d.object==='object'?d.object:{};
  if(['message_new','message_allow','message_deny','user_block','user_unblock'].includes(type)){
   const m=o.message&&typeof o.message==='object'?o.message:o;
   const user=Number(m.from_id||o.user_id||0),vkUserId=Number.isSafeInteger(user)&&user>0?String(user):null;
   const messageId=m.id==null?null:String(m.id),peerId=m.peer_id==null?null:String(m.peer_id);
   const eventId=str(d.event_id,200)||crypto.createHash('sha256').update(JSON.stringify(d)).digest('hex');
   run('INSERT OR IGNORE INTO vk_inbound_events(event_id,event_type,vk_user_id,message_id,peer_id,received_at) VALUES(?,?,?,?,?,?)',eventId,type,vkUserId,messageId,peerId,now());
   if(vkUserId&&type==='message_allow')run('UPDATE leads SET vk_messages_allowed=1,vk_permission_at=?,vk_permission_source=?,updated_at=? WHERE vk_user_id=?',now(),'vk_callback:message_allow',now(),vkUserId);
   if(vkUserId&&type==='message_deny')run('UPDATE leads SET vk_messages_allowed=0,vk_permission_at=NULL,vk_permission_source=NULL,updated_at=? WHERE vk_user_id=?',now(),vkUserId);
   if(vkUserId&&type==='user_block'){
    run('UPDATE leads SET vk_messages_allowed=0,vk_permission_at=NULL,vk_permission_source=NULL,suppressed=1,updated_at=? WHERE vk_user_id=?',now(),vkUserId);
    run('INSERT INTO suppression_list(vk_user_id,phone,reason,added_at) SELECT ?,NULL,?,? WHERE NOT EXISTS (SELECT 1 FROM suppression_list WHERE vk_user_id=?)',vkUserId,'vk-user-block',now(),vkUserId);
   }
   if(vkUserId&&type==='user_unblock')run('UPDATE leads SET suppressed=0,updated_at=? WHERE vk_user_id=?',now(),vkUserId);
  }
  res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end('ok');return;
 }
 if(p.startsWith('/api/')&&!auth(req,res))return;
 if(p.startsWith('/api/')&&req.method!=='GET'&&!originOk(req))return send(res,403,{error:'Недопустимый источник запроса'});
 if(req.method==='GET'&&p==='/api/dashboard'){const e=eligibility();return send(res,200,{counts:{offers:Number(get('SELECT COUNT(*) n FROM offers').n),draftOffers:Number(get('SELECT COUNT(*) n FROM offers WHERE status=\'draft\'').n),leads:Number(get('SELECT COUNT(*) n FROM leads').n),eligible:e.filter(x=>x.ok).length,campaigns:Number(get('SELECT COUNT(*) n FROM campaigns').n),sources:Number(get('SELECT COUNT(*) n FROM sources').n)},liveMessagingEnabled:false,recentCampaigns:many('SELECT * FROM campaigns ORDER BY id DESC LIMIT 5')});}
 if(req.method==='GET'&&p==='/api/offers'){const q=str(u.searchParams.get('q'),200).toLowerCase();const rows=many('SELECT * FROM offers ORDER BY supplied_label COLLATE NOCASE').filter(x=>!q||[x.supplied_label,x.official_brand,x.source_offer_code,x.organization_type].some(v=>String(v||'').toLowerCase().includes(q)));return send(res,200,{offers:rows.map(offerJson)});}
 const om=p.match(/^\/api\/offers\/([^/]+)$/);
 if(req.method==='PATCH'&&om){const code=decodeURIComponent(om[1]),d=await readBody(req);if(!get('SELECT source_offer_code FROM offers WHERE source_offer_code=?',code))return send(res,404,{error:'Предложение не найдено'});let cpa=d.cpa_url===undefined?undefined:str(d.cpa_url,2000);if(cpa){try{if(new URL(cpa).protocol!=='https:')throw 0;}catch{return send(res,400,{error:'CPA ссылка должна быть корректным HTTPS URL'});}}const erid=d.erid===undefined?undefined:str(d.erid,300),note=d.internal_note===undefined?undefined:str(d.internal_note,3000);run('UPDATE offers SET cpa_url=COALESCE(?,cpa_url),erid=COALESCE(?,erid),internal_note=COALESCE(?,internal_note),status=\'draft\',bot_enabled=0,updated_at=? WHERE source_offer_code=?',cpa===undefined?null:cpa,erid===undefined?null:erid,note===undefined?null:note,now(),code);return send(res,200,{ok:true,offer:offerJson(get('SELECT * FROM offers WHERE source_offer_code=?',code))});}
 if(req.method==='GET'&&p==='/api/vk/events')return send(res,200,{events:many('SELECT event_id,event_type,vk_user_id,message_id,peer_id,received_at FROM vk_inbound_events ORDER BY received_at DESC LIMIT 100'),total:Number(get('SELECT COUNT(*) n FROM vk_inbound_events').n),callbackConfigured:Boolean(process.env.VK_CALLBACK_CONFIRMATION&&process.env.VK_CALLBACK_SECRET),communityId:String(process.env.VK_COMMUNITY_ID||'243658195')});
 if(req.method==='GET'&&p==='/api/leads')return send(res,200,{leads:many('SELECT * FROM leads ORDER BY id DESC LIMIT 1000').map(leadView)});
 if(req.method==='POST'&&p==='/api/leads/import'){const d=await readBody(req);if(!Array.isArray(d.rows)||d.rows.length>5000)return send(res,400,{error:'Ожидается rows до 5000 строк'});const result={imported:0,updated:0,skipped:0,reasons:{}};db.exec('SAVEPOINT audience_import');try{for(const row of d.rows){const x=importLead(row||{});if(x.skip){result.skipped++;result.reasons[x.skip]=(result.reasons[x.skip]||0)+1;}else if(x.updated)result.updated++;else result.imported++;}db.exec('RELEASE audience_import');}catch(e){db.exec('ROLLBACK TO audience_import; RELEASE audience_import');throw e;}return send(res,200,result);}
 const lm=p.match(/^\/api\/leads\/(\d+)\/(unsubscribe|suppress|unsuppress)$/);
 if(req.method==='POST'&&lm){const id=Number(lm[1]),action=lm[2],l=get('SELECT * FROM leads WHERE id=?',id);if(!l)return send(res,404,{error:'Лид не найден'});if(action==='unsubscribe'){run('UPDATE leads SET unsubscribed=1,advertising_consent=0,advertising_consent_at=NULL,advertising_consent_source=NULL,updated_at=? WHERE id=?',now(),id);event(id,'advertising',false,now(),'user-unsubscribe');run('INSERT INTO suppression_list(vk_user_id,phone,reason,added_at) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM suppression_list WHERE (? IS NOT NULL AND vk_user_id=?) OR (? IS NOT NULL AND phone=?))',l.vk_user_id,l.phone,'unsubscribe',now(),l.vk_user_id,l.vk_user_id,l.phone,l.phone);}if(action==='suppress'){run('UPDATE leads SET suppressed=1,updated_at=? WHERE id=?',now(),id);run('INSERT INTO suppression_list(vk_user_id,phone,reason,added_at) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM suppression_list WHERE (? IS NOT NULL AND vk_user_id=?) OR (? IS NOT NULL AND phone=?))',l.vk_user_id,l.phone,'manual-suppression',now(),l.vk_user_id,l.vk_user_id,l.phone,l.phone);}if(action==='unsuppress'){run('UPDATE leads SET suppressed=0,updated_at=? WHERE id=?',now(),id);run('DELETE FROM suppression_list WHERE (vk_user_id=? AND ? IS NOT NULL) OR (phone=? AND ? IS NOT NULL)',l.vk_user_id,l.vk_user_id,l.phone,l.phone);}return send(res,200,{ok:true});}
 if(req.method==='GET'&&p==='/api/campaigns')return send(res,200,{campaigns:many('SELECT * FROM campaigns ORDER BY id DESC')});
 if(req.method==='POST'&&p==='/api/campaigns'){const d=await readBody(req),name=str(d.name,150),message=str(d.message,5000);if(!name||!message)return send(res,400,{error:'Название и текст обязательны'});const r=run('INSERT INTO campaigns(name,message,status,created_at) VALUES(?,?,?,?)',name,message,'draft',now());return send(res,201,{ok:true,id:Number(r.lastInsertRowid)});}
 const cm=p.match(/^\/api\/campaigns\/(\d+)\/(preview|dry-run|send)$/);
 if(cm&&req.method==='GET'&&cm[2]==='preview'){const id=Number(cm[1]);if(!get('SELECT id FROM campaigns WHERE id=?',id))return send(res,404,{error:'Кампания не найдена'});const a=eligibility(),reasons={};for(const x of a)if(!x.ok)reasons[x.reason]=(reasons[x.reason]||0)+1;return send(res,200,{total:a.length,eligible:a.filter(x=>x.ok).length,skipped:a.filter(x=>!x.ok).length,reasons});}
 if(cm&&req.method==='POST'&&cm[2]==='dry-run'){const id=Number(cm[1]);if(!get('SELECT id FROM campaigns WHERE id=?',id))return send(res,404,{error:'Кампания не найдена'});db.exec('SAVEPOINT dryrun');try{run('DELETE FROM campaign_recipients WHERE campaign_id=?',id);const a=eligibility(),t=now();for(const x of a)run('INSERT INTO campaign_recipients(campaign_id,lead_id,decision,reason,simulated_at) VALUES(?,?,?,?,?)',id,x.lead.id,x.ok?'eligible_simulation':'skipped',x.reason,t);const eligible=a.filter(x=>x.ok).length,skipped=a.length-eligible;run('UPDATE campaigns SET status=\'simulated\',simulated_at=?,eligible_count=?,skipped_count=? WHERE id=?',t,eligible,skipped,id);db.exec('RELEASE dryrun');return send(res,200,{ok:true,simulated:true,sent:0,total:a.length,eligible,skipped,message:'Только симуляция. Сообщения не отправлялись.'});}catch(e){db.exec('ROLLBACK TO dryrun; RELEASE dryrun');throw e;}}
 if(cm&&req.method==='POST'&&cm[2]==='send'){try{assertLiveSendDisabled();}catch{return send(res,423,{error:'Реальная отправка отключена на сервере',liveMessagingEnabled:false});}}
 if(req.method==='GET'&&p==='/api/sources')return send(res,200,{sources:many('SELECT * FROM sources ORDER BY id DESC')});
 if(req.method==='POST'&&p==='/api/sources'){const d=await readBody(req),name=str(d.name,180),url=str(d.url,1500);if(!name)return send(res,400,{error:'Укажите название'});if(url){try{if(!['https:','http:'].includes(new URL(url).protocol))throw 0;}catch{return send(res,400,{error:'Некорректная ссылка'});}}const r=run('INSERT INTO sources(name,url,source_type,notes,created_at) VALUES(?,?,?,?,?)',name,url||null,d.source_type==='vk_ads'?'vk_ads':'manual',str(d.notes,2000),now());return send(res,201,{ok:true,id:Number(r.lastInsertRowid)});}
 if(req.method==='GET'&&p==='/api/settings')return send(res,200,{settings:settings()});
 if(req.method==='PUT'&&p==='/api/settings'){const d=await readBody(req),old=settings(),merged={...old,...d,bot:{...old.bot,...(d.bot||{})},integrations:{...old.integrations,...(d.integrations||{})},liveMessagingEnabled:false};merged.integrations.vkApiConnected=false;merged.integrations.callbackSecretConfigured=false;saveSettings(merged);return send(res,200,{ok:true,settings:merged});}
 if(req.method==='GET'&&p==='/api/analytics'){const a=eligibility();return send(res,200,{leadsBySource:many('SELECT COALESCE(source,\'не указан\') source,COUNT(*) count FROM leads GROUP BY source ORDER BY count DESC'),campaigns:many('SELECT id,name,status,eligible_count,skipped_count,simulated_at FROM campaigns ORDER BY id DESC'),consent:{personalData:Number(get('SELECT COUNT(*) n FROM leads WHERE personal_data_consent=1').n),advertising:Number(get('SELECT COUNT(*) n FROM leads WHERE advertising_consent=1').n),messaging:Number(get('SELECT COUNT(*) n FROM leads WHERE vk_messages_allowed=1').n),eligible:a.filter(x=>x.ok).length}});}
 if(p.startsWith('/api/'))return send(res,404,{error:'API endpoint not found'});
 if(!['GET','HEAD'].includes(req.method))return send(res,405,{error:'Method not allowed'});
 let rel=p==='/'?'index.html':path.normalize(decodeURIComponent(p)).replace(/^[/\\]+/,'');
 const base=path.resolve(ROOT,'public-v2'),target=path.resolve(base,rel);
 if(!target.startsWith(base+path.sep))return send(res,403,{error:'Forbidden'});
 if(!fs.existsSync(target)||!fs.statSync(target).isFile())return send(res,404,{error:'Not found'});
 const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
 res.writeHead(200,{'content-type':types[path.extname(target)]||'application/octet-stream','cache-control':path.extname(target)==='.html'?'no-store':'public, max-age=300','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'"});
 if(req.method==='HEAD')return res.end();fs.createReadStream(target).pipe(res);
}
const server=http.createServer((req,res)=>route(req,res).catch(e=>{console.error('request_error',e);if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'Внутренняя ошибка сервера'});else res.destroy();}));
const port=Number(process.env.PORT||3000);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))server.listen(port,'0.0.0.0',()=>console.log('VK LeadBot v2 on '+port+'; live messaging disabled'));
export {server,db};
