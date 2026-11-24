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
'CREATE TABLE IF NOT EXISTS campaigns(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'draft\',created_at TEXT NOT NULL,simulated_at TEXT,eligible_count INTEGER NOT NULL DEFAULT 0,skipped_count INTEGER NOT NULL DEFAULT 0)',
'CREATE TABLE IF NOT EXISTS campaign_recipients(id INTEGER PRIMARY KEY AUTOINCREMENT,campaign_id INTEGER NOT NULL,lead_id INTEGER NOT NULL,decision TEXT NOT NULL,reason TEXT,simulated_at TEXT NOT NULL,FOREIGN KEY(campaign_id) REFERENCES campaigns(id),FOREIGN KEY(lead_id) REFERENCES leads(id))',
'CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,url TEXT,source_type TEXT NOT NULL DEFAULT \'manual\',notes TEXT,created_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS bot_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS suppression_list(id INTEGER PRIMARY KEY AUTOINCREMENT,vk_user_id TEXT,phone TEXT,reason TEXT NOT NULL,added_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS vk_inbound_events(event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,vk_user_id TEXT,message_id TEXT,peer_id TEXT,received_at TEXT NOT NULL)',
'CREATE TABLE IF NOT EXISTS cpa_showcase_links(source_offer_code TEXT PRIMARY KEY,label TEXT NOT NULL,cpa_url TEXT NOT NULL,erid TEXT,source_erid TEXT,erid_status TEXT NOT NULL,publication_enabled INTEGER NOT NULL DEFAULT 0,block_reason TEXT,received_at TEXT NOT NULL,advertiser_name TEXT,advertiser_site TEXT,erid_verified INTEGER NOT NULL DEFAULT 0,terms_verified INTEGER NOT NULL DEFAULT 0)',
'CREATE TABLE IF NOT EXISTS vk_dialog_state(vk_user_id TEXT PRIMARY KEY,state TEXT NOT NULL,updated_at TEXT NOT NULL)'
].join(';\n') + ';');
function ensureColumn(table,column,definition){const columns=db.prepare('PRAGMA table_info('+table+')').all();if(!columns.some(x=>x.name===column))db.exec('ALTER TABLE '+table+' ADD COLUMN '+column+' '+definition);}
ensureColumn('cpa_showcase_links','source_erid','TEXT');ensureColumn('cpa_showcase_links','advertiser_name','TEXT');ensureColumn('cpa_showcase_links','advertiser_site','TEXT');ensureColumn('cpa_showcase_links','erid_verified','INTEGER NOT NULL DEFAULT 0');ensureColumn('cpa_showcase_links','terms_verified','INTEGER NOT NULL DEFAULT 0');db.exec('DROP TABLE IF EXISTS consent_events');
db.exec('CREATE INDEX IF NOT EXISTS idx_lead_eligibility ON leads(advertising_consent,vk_messages_allowed,unsubscribed,suppressed); CREATE INDEX IF NOT EXISTS idx_campaign_recipient ON campaign_recipients(campaign_id);');
const now=()=>new Date().toISOString(), sessions=new Map(), attempts=new Map();
const DEFAULT={bot:{greeting:'Здравствуйте! Поможем ознакомиться с доступными предложениями. Мы не являемся кредитором и не гарантируем одобрение.',explanation:'Номер телефона нужен, чтобы подобрать и передать вам доступные предложения партнёров. Мы не являемся кредитором и не гарантируем одобрение.',phonePrompt:'Укажите номер телефона для обратной связи.',offersIntro:'Ниже представлены предложения. Изучите условия на сайте поставщика.',support:'По вопросам работы сервиса обратитесь в поддержку.'},privacyUrl:'',supportUrl:'',vkGroupUrl:'',integrations:{vkCommunityId:'',vkApiConnected:false,callbackSecretConfigured:false},liveMessagingEnabled:false};
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
function importShowcaseLinks(){
 const file=path.join(ROOT,'research/cpa-offer-links-2026-11-24.json');
 if(!fs.existsSync(file))return 0;
 const data=JSON.parse(fs.readFileSync(file,'utf8'));
 const up=db.prepare(`INSERT INTO cpa_showcase_links(source_offer_code,label,cpa_url,erid,source_erid,erid_status,publication_enabled,block_reason,received_at) VALUES(?,?,?,?,?,?,0,?,?) ON CONFLICT(source_offer_code) DO UPDATE SET label=excluded.label,publication_enabled=CASE WHEN cpa_showcase_links.cpa_url=excluded.cpa_url AND COALESCE(cpa_showcase_links.source_erid,'')=COALESCE(excluded.source_erid,'') THEN cpa_showcase_links.publication_enabled ELSE 0 END,erid_verified=CASE WHEN cpa_showcase_links.cpa_url=excluded.cpa_url AND COALESCE(cpa_showcase_links.source_erid,'')=COALESCE(excluded.source_erid,'') THEN cpa_showcase_links.erid_verified ELSE 0 END,terms_verified=CASE WHEN cpa_showcase_links.cpa_url=excluded.cpa_url AND COALESCE(cpa_showcase_links.source_erid,'')=COALESCE(excluded.source_erid,'') THEN cpa_showcase_links.terms_verified ELSE 0 END,advertiser_name=CASE WHEN cpa_showcase_links.cpa_url=excluded.cpa_url AND COALESCE(cpa_showcase_links.source_erid,'')=COALESCE(excluded.source_erid,'') THEN cpa_showcase_links.advertiser_name ELSE NULL END,advertiser_site=CASE WHEN cpa_showcase_links.cpa_url=excluded.cpa_url AND COALESCE(cpa_showcase_links.source_erid,'')=COALESCE(excluded.source_erid,'') THEN cpa_showcase_links.advertiser_site ELSE NULL END,erid=CASE WHEN cpa_showcase_links.cpa_url=excluded.cpa_url AND COALESCE(cpa_showcase_links.source_erid,'')=COALESCE(excluded.source_erid,'') THEN cpa_showcase_links.erid ELSE excluded.erid END,source_erid=excluded.source_erid,erid_status=CASE WHEN cpa_showcase_links.cpa_url=excluded.cpa_url AND COALESCE(cpa_showcase_links.source_erid,'')=COALESCE(excluded.source_erid,'') THEN cpa_showcase_links.erid_status ELSE excluded.erid_status END,cpa_url=excluded.cpa_url,block_reason=excluded.block_reason,received_at=excluded.received_at`);
 let count=0;
 for(const r of data.records||[]){
  const code=str(r.source_offer_code,20),label=str(r.label,200),url=str(r.url,2000);
  if(!/^\d+$/.test(code)||!label)continue;
  let parsed;try{parsed=new URL(url);}catch{continue;}
  if(parsed.protocol!=='https:'||parsed.hostname!=='bit-do.ru'||!parsed.pathname.startsWith('/'+code+'-'))continue;
  const sourceErid=r.erid?str(r.erid,200):null;up.run(code,label,url,sourceErid,sourceErid,str(r.erid_status,100)||'not-verified',r.block_reason?str(r.block_reason,500):null,str(r.received_at,40)||now());
  count++;
 }
 return count;
}
const showcaseImport=importShowcaseLinks();

function settings(){const r=get('SELECT value_json FROM bot_settings WHERE key=?','main');return r?JSON.parse(r.value_json):DEFAULT;}
function saveSettings(v){run('INSERT INTO bot_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at','main',JSON.stringify(v),now());}
function leadView(l){return {id:l.id,vk_user_id:l.vk_user_id,phone:l.phone,source:l.source,personal_data_consent:!!l.personal_data_consent,personal_data_consent_at:l.personal_data_consent_at,personal_data_consent_source:l.personal_data_consent_source,advertising_consent:!!l.advertising_consent,advertising_consent_at:l.advertising_consent_at,advertising_consent_source:l.advertising_consent_source,vk_messages_allowed:!!l.vk_messages_allowed,vk_permission_at:l.vk_permission_at,vk_permission_source:l.vk_permission_source,unsubscribed:!!l.unsubscribed,suppressed:!!l.suppressed,eligible:canSendToLead(l).ok};}
function withSuppression(){return many('SELECT l.*,CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS in_suppression FROM leads l LEFT JOIN suppression_list s ON (s.vk_user_id=l.vk_user_id AND l.vk_user_id IS NOT NULL) OR (s.phone=l.phone AND l.phone IS NOT NULL)');}
function eligibility(){return withSuppression().map(l=>{const x=canSendToLead({...l,suppressed:!!l.suppressed||!!l.in_suppression});return {lead:l,ok:x.ok,reason:x.reason};});}
function vkBotReady(){return process.env.VK_BOT_REPLIES_ENABLED==='true'&&Boolean(process.env.VK_ACCESS_TOKEN||process.env.VK_GROUP_TOKEN)&&Boolean(process.env.VK_CALLBACK_CONFIRMATION&&process.env.VK_CALLBACK_SECRET);}
function showcaseUrl(req){const base=process.env.PUBLIC_BASE_URL||('https://'+String(req.headers['x-forwarded-host']||req.headers.host||'localhost'));try{return new URL('/showcase',base).toString();}catch{return 'https://vk.ru/club243658195';}}
function botKeyboard(buttons){return JSON.stringify({one_time:false,buttons:buttons.map(b=>[{action:b.link?{type:'open_link',label:b.label,link:b.link}:{type:'text',label:b.label,payload:JSON.stringify(b.payload||{})},color:b.color||'primary'}])});}
async function sendVkBotMessage(peerId,message,keyboard){
 const token=process.env.VK_ACCESS_TOKEN||process.env.VK_GROUP_TOKEN;if(!vkBotReady()||!token)throw new Error('VK bot reply is disabled');
 const params=new URLSearchParams({peer_id:String(peerId),random_id:String(crypto.randomInt(1,2147483647)),message:String(message).slice(0,4000),access_token:token,v:String(process.env.VK_API_VERSION||'5.199'),group_id:String(process.env.VK_COMMUNITY_ID||'243658195'),intent:'default'});
 if(keyboard)params.set('keyboard',keyboard);
 const endpoint=process.env.VK_API_BASE_URL||'https://api.vk.com/method/messages.send';
 const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:params,signal:AbortSignal.timeout(8000)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok||data.error||data.response==null)throw new Error('VK messages.send failed: '+String(data.error?.error_code||response.status));
 return data.response;
}
function publishedBotOffers(){return many("SELECT source_offer_code,label,cpa_url,erid,advertiser_name,advertiser_site FROM cpa_showcase_links WHERE block_reason IS NULL AND publication_enabled=1 AND erid_verified=1 AND terms_verified=1 AND erid IS NOT NULL AND erid<>'' AND erid<>'static' AND advertiser_name IS NOT NULL AND advertiser_name<>'' AND advertiser_site IS NOT NULL AND advertiser_site<>'' ORDER BY label COLLATE NOCASE LIMIT 4");}
async function sendOffersToVkUser(vkUserId,req){
 const offers=publishedBotOffers(),allUrl=showcaseUrl(req);
 if(!offers.length){
  await sendVkBotMessage(vkUserId,'Спасибо, номер сохранён. Сейчас партнёрские предложения проходят проверку, поэтому прямые переходы пока недоступны. Предварительный каталог: '+allUrl,botKeyboard([{label:'Все предложения',link:allUrl,color:'primary'},{label:'Получить предложения',payload:{cmd:'get_offers'},color:'secondary'}]));
  return;
 }
 const parts=['Подобрали предложения партнёров. Сравните условия и полную стоимость до оформления.'];
 for(let i=0;i<offers.length;i++){const o=offers[i];parts.push((i+1)+'. '+o.label+'\nРеклама. Рекламодатель: '+o.advertiser_name+'; сайт рекламодателя: '+o.advertiser_site+'; ERID: '+o.erid);}
 const buttons=offers.map((o,i)=>({label:(i+1)+'. '+o.label.slice(0,35),link:o.cpa_url}));buttons.push({label:'Все предложения',link:allUrl,color:'secondary'});
 await sendVkBotMessage(vkUserId,parts.join('\n\n'),botKeyboard(buttons));
}
function phoneFromMessage(message){
 const text=str(message.text,500),match=text.match(/\+?\s*\d[\d\s().-]{8,}\d/);
 if(!match)return null;const candidate=match[0].trim().replace(/[\s().-]/g,'');return validPhone(candidate)?candidate:null;
}
async function handleVkUserMessage(message,vkUserId,req){
 const text=str(message.text,1000),normal=text.toLowerCase().replace(/[ё]/g,'е').replace(/[^a-zа-я0-9+]+/g,' ').trim();
 let payload={};try{payload=typeof message.payload==='string'?JSON.parse(message.payload):(message.payload||{});}catch{}
 const wantsOffers=payload.cmd==='get_offers'||['получить предложения','получить предложение','подобрать предложения','начать','start'].includes(normal);
 let state=get('SELECT state FROM vk_dialog_state WHERE vk_user_id=?',vkUserId)?.state||'start';
 if(wantsOffers){
  const lead=get('SELECT phone FROM leads WHERE vk_user_id=?',vkUserId);
  if(lead?.phone){setVkDialogState(vkUserId,'offers_sent');await sendOffersToVkUser(vkUserId,req);return;}
  setVkDialogState(vkUserId,'waiting_phone');
  const cfg=settings(),privacy=cfg.privacyUrl?' Подробнее о данных: '+cfg.privacyUrl:'';
  const explanation='Чтобы показать предложения, отправьте номер телефона сообщением. Он будет сохранён в базе сервиса для обработки вашего обращения. Переходы к партнёрам вы выбираете сами. Мы не кредитор и не гарантируем одобрение.'+privacy;
  await sendVkBotMessage(vkUserId,explanation+'\n\n'+(cfg.bot.phonePrompt||'Отправьте номер телефона, например +7 900 000-00-00.'),botKeyboard([{label:'Получить предложения',payload:{cmd:'get_offers'},color:'secondary'}]));return;
 }
 if(state==='waiting_phone'){
  const phone=phoneFromMessage(message);
  if(!phone){await sendVkBotMessage(vkUserId,'Не получилось распознать номер. Отправьте его в формате +7 900 000-00-00.',botKeyboard([{label:'Ввести номер',payload:{cmd:'get_offers'},color:'secondary'}]));return;}
  const duplicate=get('SELECT vk_user_id FROM leads WHERE phone=? AND vk_user_id<>? LIMIT 1',phone,vkUserId);
  if(duplicate){await sendVkBotMessage(vkUserId,'Этот номер уже связан с другим обращением. Проверьте номер и отправьте свой актуальный номер телефона.',null);return;}
  const at=now();run("INSERT INTO leads(vk_user_id,phone,source,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(vk_user_id) DO UPDATE SET phone=excluded.phone,source=excluded.source,updated_at=excluded.updated_at",vkUserId,phone,'vk-requested-offer',at,at);
  setVkDialogState(vkUserId,'offers_sent');await sendOffersToVkUser(vkUserId,req);return;
 }
 const cfg=settings();
 await sendVkBotMessage(vkUserId,(cfg.bot.greeting||DEFAULT.bot.greeting)+'\n\nНажмите кнопку ниже, чтобы получить предложения.',botKeyboard([{label:'Получить предложения',payload:{cmd:'get_offers'},color:'primary'}]));
}
function setVkDialogState(vkUserId,state){run('INSERT INTO vk_dialog_state(vk_user_id,state,updated_at) VALUES(?,?,?) ON CONFLICT(vk_user_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at',vkUserId,state,now());}

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
 return {id,updated:!!old};
}
async function route(req,res){
 const u=new URL(req.url,'http://'+(req.headers.host||'localhost')),p=u.pathname;
 if(req.method==='GET'&&p==='/api/health')return send(res,200,{ok:true,botReplyEnabled:vkBotReady(),vkBotTokenConfigured:Boolean(process.env.VK_ACCESS_TOKEN||process.env.VK_GROUP_TOKEN),totalOffers:Number(get('SELECT COUNT(*) n FROM offers').n),offersDraft:Number(get('SELECT COUNT(*) n FROM offers WHERE status=\'draft\' AND bot_enabled=0').n),bootImport,liveMessagingEnabled:false,vkCommunityId:String(process.env.VK_COMMUNITY_ID||'243658195'),vkCallbackConfigured:Boolean(process.env.VK_CALLBACK_CONFIRMATION&&process.env.VK_CALLBACK_SECRET),showcaseTotal:Number(get('SELECT COUNT(*) n FROM cpa_showcase_links').n),showcaseImport});
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
   const recorded=run('INSERT OR IGNORE INTO vk_inbound_events(event_id,event_type,vk_user_id,message_id,peer_id,received_at) VALUES(?,?,?,?,?,?)',eventId,type,vkUserId,messageId,peerId,now());
   if(vkUserId&&Number(peerId)===Number(vkUserId)&&type==='message_new'&&recorded.changes===1&&vkBotReady()){try{await handleVkUserMessage(m,vkUserId,req);}catch(error){console.warn('vk_bot_reply_failed',String(error.message||error).slice(0,180));}}
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
 if(req.method==='GET'&&p==='/api/public/showcase'){
  const rows=many(`SELECT c.source_offer_code,c.label,c.erid,c.erid_status,c.cpa_url,c.advertiser_name,c.advertiser_site,c.erid_verified,c.terms_verified,c.publication_enabled,o.organization_type FROM cpa_showcase_links c LEFT JOIN offers o ON o.source_offer_code=c.source_offer_code WHERE c.block_reason IS NULL ORDER BY c.label COLLATE NOCASE`);
  const offers=rows.map(x=>{const enabled=Boolean(x.publication_enabled&&x.erid_verified&&x.terms_verified&&x.erid&&x.erid!=='static'&&x.advertiser_name&&x.advertiser_site);return {code:x.source_offer_code,label:x.label,organizationType:x.organization_type||'не подтверждён',eridStatus:x.erid_status,hasErid:Boolean(x.erid&&x.erid!=='static'),clickEnabled:enabled,url:enabled?x.cpa_url:null,advertiserName:enabled?x.advertiser_name:null,advertiserSite:enabled?x.advertiser_site:null,erid:enabled?x.erid:null,reviewStatus:enabled?'approved':'draft'};});
  return send(res,200,{offers,total:rows.length,enabled:offers.filter(x=>x.clickEnabled).length,excluded:Number(get('SELECT COUNT(*) n FROM cpa_showcase_links WHERE block_reason IS NOT NULL').n),publicationEnabled:offers.some(x=>x.clickEnabled),warning:'Переходы открываются только после ручной проверки рекламодателя, условий и ERID.'});
 }
 if(p.startsWith('/api/')&&!auth(req,res))return;
 if(p.startsWith('/api/')&&req.method!=='GET'&&!originOk(req))return send(res,403,{error:'Недопустимый источник запроса'});
 if(req.method==='GET'&&p==='/api/showcase/summary')return send(res,200,{total:Number(get('SELECT COUNT(*) n FROM cpa_showcase_links').n),readyForReview:Number(get('SELECT COUNT(*) n FROM cpa_showcase_links WHERE block_reason IS NULL').n),excluded:Number(get('SELECT COUNT(*) n FROM cpa_showcase_links WHERE block_reason IS NOT NULL').n),withErid:Number(get("SELECT COUNT(*) n FROM cpa_showcase_links WHERE erid IS NOT NULL AND erid<>'' AND erid<>'static'").n),withoutErid:Number(get("SELECT COUNT(*) n FROM cpa_showcase_links WHERE erid IS NULL OR erid=''").n),staticErid:Number(get("SELECT COUNT(*) n FROM cpa_showcase_links WHERE erid='static'").n),publicationEnabled:Number(get('SELECT COUNT(*) n FROM cpa_showcase_links WHERE publication_enabled=1 AND erid_verified=1 AND terms_verified=1 AND advertiser_name IS NOT NULL AND advertiser_site IS NOT NULL').n)});
 if(req.method==='GET'&&p==='/api/showcase/links')return send(res,200,{links:many('SELECT source_offer_code,label,cpa_url,erid,erid_status,block_reason,advertiser_name,advertiser_site,erid_verified,terms_verified,publication_enabled FROM cpa_showcase_links ORDER BY label COLLATE NOCASE')});
 const showcaseEdit=p.match(/^\/api\/showcase\/links\/(\d+)$/);
 if(req.method==='PATCH'&&showcaseEdit){
  const code=showcaseEdit[1],current=get('SELECT * FROM cpa_showcase_links WHERE source_offer_code=?',code);if(!current)return send(res,404,{error:'Предложение не найдено'});
  const d=await readBody(req),advertiserName=str(d.advertiser_name,300),advertiserSite=str(d.advertiser_site,1000),erid=str(d.erid,200);
  let siteOk=false;try{const site=new URL(advertiserSite);siteOk=site.protocol==='https:';}catch{}
  const eridVerified=d.erid_verified===true&&/^[A-Za-z0-9_-]{5,120}$/.test(erid)&&erid!=='static';
  const termsVerified=d.terms_verified===true;
  const enabled=Boolean(d.publication_enabled===true&&advertiserName&&siteOk&&eridVerified&&termsVerified&&!current.block_reason);
  run('UPDATE cpa_showcase_links SET advertiser_name=?,advertiser_site=?,erid=?,erid_verified=?,terms_verified=?,publication_enabled=? WHERE source_offer_code=?',advertiserName||null,siteOk?advertiserSite:null,erid||null,eridVerified?1:0,termsVerified?1:0,enabled?1:0,code);
  return send(res,200,{ok:true,publicationEnabled:enabled,requires:{advertiserName:true,httpsAdvertiserSite:true,validErid:true,termsConfirmed:true}});
 }
 if(req.method==='GET'&&p==='/api/dashboard'){const e=eligibility();return send(res,200,{counts:{offers:Number(get('SELECT COUNT(*) n FROM offers').n),draftOffers:Number(get('SELECT COUNT(*) n FROM offers WHERE status=\'draft\'').n),leads:Number(get('SELECT COUNT(*) n FROM leads').n),leadsWithPhone:Number(get('SELECT COUNT(*) n FROM leads WHERE phone IS NOT NULL AND length(phone)>0').n),eligible:e.filter(x=>x.ok).length,campaigns:Number(get('SELECT COUNT(*) n FROM campaigns').n),sources:Number(get('SELECT COUNT(*) n FROM sources').n)},botReplyEnabled:vkBotReady(),liveMessagingEnabled:false,recentCampaigns:many('SELECT * FROM campaigns ORDER BY id DESC LIMIT 5')});}
 if(req.method==='GET'&&p==='/api/offers'){const q=str(u.searchParams.get('q'),200).toLowerCase();const rows=many('SELECT * FROM offers ORDER BY supplied_label COLLATE NOCASE').filter(x=>!q||[x.supplied_label,x.official_brand,x.source_offer_code,x.organization_type].some(v=>String(v||'').toLowerCase().includes(q)));return send(res,200,{offers:rows.map(offerJson)});}
 const om=p.match(/^\/api\/offers\/([^/]+)$/);
 if(req.method==='PATCH'&&om){const code=decodeURIComponent(om[1]),d=await readBody(req);if(!get('SELECT source_offer_code FROM offers WHERE source_offer_code=?',code))return send(res,404,{error:'Предложение не найдено'});let cpa=d.cpa_url===undefined?undefined:str(d.cpa_url,2000);if(cpa){try{if(new URL(cpa).protocol!=='https:')throw 0;}catch{return send(res,400,{error:'CPA ссылка должна быть корректным HTTPS URL'});}}const erid=d.erid===undefined?undefined:str(d.erid,300),note=d.internal_note===undefined?undefined:str(d.internal_note,3000);run('UPDATE offers SET cpa_url=COALESCE(?,cpa_url),erid=COALESCE(?,erid),internal_note=COALESCE(?,internal_note),status=\'draft\',bot_enabled=0,updated_at=? WHERE source_offer_code=?',cpa===undefined?null:cpa,erid===undefined?null:erid,note===undefined?null:note,now(),code);return send(res,200,{ok:true,offer:offerJson(get('SELECT * FROM offers WHERE source_offer_code=?',code))});}
 if(req.method==='GET'&&p==='/api/vk/events')return send(res,200,{events:many('SELECT event_id,event_type,vk_user_id,message_id,peer_id,received_at FROM vk_inbound_events ORDER BY received_at DESC LIMIT 100'),total:Number(get('SELECT COUNT(*) n FROM vk_inbound_events').n),callbackConfigured:Boolean(process.env.VK_CALLBACK_CONFIRMATION&&process.env.VK_CALLBACK_SECRET),botReplyEnabled:vkBotReady(),vkBotTokenConfigured:Boolean(process.env.VK_ACCESS_TOKEN||process.env.VK_GROUP_TOKEN),communityId:String(process.env.VK_COMMUNITY_ID||'243658195')});
 if(req.method==='GET'&&p==='/api/leads')return send(res,200,{leads:many('SELECT * FROM leads ORDER BY id DESC LIMIT 1000').map(leadView)});
 if(req.method==='POST'&&p==='/api/leads/import'){const d=await readBody(req);if(!Array.isArray(d.rows)||d.rows.length>5000)return send(res,400,{error:'Ожидается rows до 5000 строк'});const result={imported:0,updated:0,skipped:0,reasons:{}};db.exec('SAVEPOINT audience_import');try{for(const row of d.rows){const x=importLead(row||{});if(x.skip){result.skipped++;result.reasons[x.skip]=(result.reasons[x.skip]||0)+1;}else if(x.updated)result.updated++;else result.imported++;}db.exec('RELEASE audience_import');}catch(e){db.exec('ROLLBACK TO audience_import; RELEASE audience_import');throw e;}return send(res,200,result);}
 const lm=p.match(/^\/api\/leads\/(\d+)\/(unsubscribe|suppress|unsuppress)$/);
 if(req.method==='POST'&&lm){const id=Number(lm[1]),action=lm[2],l=get('SELECT * FROM leads WHERE id=?',id);if(!l)return send(res,404,{error:'Лид не найден'});if(action==='unsubscribe'){run('UPDATE leads SET unsubscribed=1,advertising_consent=0,advertising_consent_at=NULL,advertising_consent_source=NULL,updated_at=? WHERE id=?',now(),id);run('INSERT INTO suppression_list(vk_user_id,phone,reason,added_at) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM suppression_list WHERE (? IS NOT NULL AND vk_user_id=?) OR (? IS NOT NULL AND phone=?))',l.vk_user_id,l.phone,'unsubscribe',now(),l.vk_user_id,l.vk_user_id,l.phone,l.phone);}if(action==='suppress'){run('UPDATE leads SET suppressed=1,updated_at=? WHERE id=?',now(),id);run('INSERT INTO suppression_list(vk_user_id,phone,reason,added_at) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM suppression_list WHERE (? IS NOT NULL AND vk_user_id=?) OR (? IS NOT NULL AND phone=?))',l.vk_user_id,l.phone,'manual-suppression',now(),l.vk_user_id,l.vk_user_id,l.phone,l.phone);}if(action==='unsuppress'){run('UPDATE leads SET suppressed=0,updated_at=? WHERE id=?',now(),id);run('DELETE FROM suppression_list WHERE (vk_user_id=? AND ? IS NOT NULL) OR (phone=? AND ? IS NOT NULL)',l.vk_user_id,l.vk_user_id,l.phone,l.phone);}return send(res,200,{ok:true});}
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
 let rel=(p==='/showcase'||p==='/showcase/')?'showcase.html':(p==='/'?'index.html':path.normalize(decodeURIComponent(p)).replace(/^[/\\]+/,''));
 const base=path.resolve(ROOT,'public-v2'),target=path.resolve(base,rel);
 if(!target.startsWith(base+path.sep))return send(res,403,{error:'Forbidden'});
 if(!fs.existsSync(target)||!fs.statSync(target).isFile())return send(res,404,{error:'Not found'});
 const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
 res.writeHead(200,{'content-type':types[path.extname(target)]||'application/octet-stream','cache-control':path.extname(target)==='.html'?'no-store':'public, max-age=300','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'"});
 if(req.method==='HEAD')return res.end();fs.createReadStream(target).pipe(res);
}
const server=http.createServer((req,res)=>route(req,res).catch(e=>{console.error('request_error',e);if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'Внутренняя ошибка сервера'});else res.destroy();}));
const port=Number(process.env.PORT||3000);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))server.listen(port,'0.0.0.0',()=>console.log('VK LeadBot v2 on '+port+'; campaign sending disabled; bot replies '+(vkBotReady()?'enabled':'disabled')));
export {server,db};
