const $=s=>document.querySelector(s);
let offers=[];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function typeLabel(v){const x=String(v||'не подтверждён');return x==='не подтверждён'?'Тип требует проверки':x;}
function render(){
 const q=$('#search').value.trim().toLowerCase(),type=$('#type').value;
 const list=offers.filter(x=>(!type||x.organizationType===type)&&(!q||(x.label+' '+x.code+' '+x.organizationType).toLowerCase().includes(q)));
 $('#count').textContent='Показано '+list.length+' из '+offers.length+' карточек. '+(q||type?'Фильтр применён.':'');
 $('#cards').innerHTML=list.length?list.map(x=>{
  const erid=x.eridStatus==='static-value-needs-confirmation'?'В ссылке указано ERID=static — требуется проверка':x.hasErid?'ERID присутствует в ссылке':'ERID в присланной ссылке не указан';
  return '<article class="card"><div class="card-top"><h3>'+esc(x.label)+'</h3><span class="code">№ '+esc(x.code)+'</span></div><span class="kind">'+esc(typeLabel(x.organizationType))+'</span><div class="status">Предварительная проверка не завершена</div><div class="meta">'+esc(erid)+'</div><button type="button" disabled>Переход пока отключён</button></article>';
 }).join(''):'<div class="empty">По такому запросу ничего не найдено.</div>';
}
async function init(){
 try{
  const r=await fetch('/api/public/showcase',{headers:{accept:'application/json'},cache:'no-store'});
  if(!r.ok)throw new Error('HTTP '+r.status);
  const d=await r.json();offers=d.offers||[];
  const types=[...new Set(offers.map(x=>x.organizationType).filter(x=>x&&x!=='не подтверждён'))].sort((a,b)=>a.localeCompare(b,'ru'));
  $('#type').insertAdjacentHTML('beforeend',types.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join(''));
  $('#count').textContent='Всего подготовлено '+d.total+' карточек; исключено из витрины: '+d.excluded+'.';
  $('#search').addEventListener('input',render);$('#type').addEventListener('change',render);
  render();
 }catch(e){$('#count').textContent='Не удалось загрузить каталог.';$('#cards').innerHTML='<div class="empty">Ошибка загрузки. Обновите страницу позже.</div>';}
}
init();