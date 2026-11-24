export function parseConsentFlag(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (value == null || value === '') return null;
  const s = String(value).trim().toLowerCase();
  if (['1','true','yes','y','да','согласен','согласна'].includes(s)) return true;
  if (['0','false','no','n','нет','не согласен','не согласна'].includes(s)) return false;
  return null;
}
export function validPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}
export function canSendToLead(lead) {
  if (lead.unsubscribed) return { ok:false, reason:'Отписка' };
  if (lead.suppressed || lead.in_suppression) return { ok:false, reason:'Стоп-лист' };
  if (!lead.personal_data_consent || !lead.personal_data_consent_at || !lead.personal_data_consent_source) return { ok:false, reason:'Нет подтверждённого согласия на обработку персональных данных' };
  if (!lead.advertising_consent || !lead.advertising_consent_at || !lead.advertising_consent_source) return { ok:false, reason:'Нет подтверждённого согласия на рекламу' };
  if (!lead.vk_messages_allowed || !lead.vk_permission_at || !lead.vk_permission_source) return { ok:false, reason:'Нет подтверждённого разрешения на сообщения VK' };
  if (!lead.vk_user_id) return { ok:false, reason:'Нет VK ID для отправки через сообщество' };
  return { ok:true, reason:null };
}
export function assertLiveSendDisabled() {
  throw Object.assign(new Error('Live VK messaging is disabled'), { code:'LIVE_SEND_DISABLED', status:423 });
}
export function parseCsv(input) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i=0;i<text.length;i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i+1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') {
      if (field.length) throw new Error('Кавычка внутри некавыченного поля CSV');
      quoted = true;
    } else if (ch === ',') { row.push(field); field=''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); if (row.some(x=>x.trim())) rows.push(row); row=[]; field=''; }
    else field += ch;
  }
  if (quoted) throw new Error('Незакрытая кавычка в CSV');
  row.push(field.replace(/\r$/, '')); if (row.some(x=>x.trim())) rows.push(row);
  if (!rows.length) return [];
  const headers = rows.shift().map(x=>x.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('В CSV повторяются названия столбцов');
  return rows.map(values=>Object.fromEntries(headers.map((h,i)=>[h, values[i] ?? ''])));
}
