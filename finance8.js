'use strict';
const fs = require('node:fs');
const path = require('node:path');
const FILE = path.join(process.env.DATA_DIR || __dirname, 'finance8.json');
let state = { rates: { agent: 0.07, overhead: 6669.917965238238 }, cases: {} };
if (fs.existsSync(FILE)) state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
function num(v) { if(v === '' || v == null) return null; const n=Number(v); if(!Number.isFinite(n) || n<0) throw Error('Введите конечное неотрицательное число'); return n; }
function calculate(input, rates, area, cost) {
 const sale=num(input.sale), down=num(input.down) || 0, subsidy=num(input.subsidy) || 0;
 const agentRate=num(rates.agent), overheadRate=num(rates.overhead);
 if(sale===null || area==null || !Number.isFinite(Number(area)) || Number(area)<=0 || cost==null || !Number.isFinite(Number(cost)) || agentRate===null || overheadRate===null) return {agent:null,overhead:null,net:null,perM2:null};
 const agent=(sale-down)*agentRate, overhead=overheadRate*Number(area);
 const net=sale-down-subsidy-agent-overhead-Number(cost);
 return {agent,overhead,net,perM2:net/Number(area)};
}
function key(q) { return JSON.stringify([q.project,q.planning,q.vid]); }
function get(q) { return state.cases[key(q)] || {sale:null,down:null,subsidy:null,discount:null}; }
function persist(next) { const tmp=FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(next,null,2)); fs.renameSync(tmp,FILE); state=next; }
async function save(req,res,role) {
 const reply=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj));};
 if(!role.finance8) return reply(403,{ok:false,error:'Нет прав (роль 8)'});
 try {
  let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)return reply(413,{ok:false,error:'Слишком большой запрос'});}
  const obj=JSON.parse(body);const next=JSON.parse(JSON.stringify(state));
  if(obj.kind==='rates') {
   const agent=num(obj.agent), overhead=num(obj.overhead);
   if(agent===null || overhead===null || agent>1)throw Error('Ставка агентского вознаграждения должна быть от 0 до 100%, накладные расходы обязательны');
   next.rates={agent,overhead};
  } else if(obj.kind==='case') {
   if(!Array.isArray(obj.context)||obj.context.length!==3||obj.context.some(x=>typeof x!=='string'||x.length>200))throw Error('Неверный контекст расчета');
   const values={};for(const k of ['sale','down','subsidy','discount']){if(!own(obj,k))throw Error('Не передано поле '+k);values[k]=num(obj[k]);}
   next.cases[JSON.stringify(obj.context)]=values;
  } else throw Error('Неверная операция');
  persist(next);reply(200,{ok:true});
 } catch(error) {reply(error instanceof SyntaxError || !error.code ? 400:500,{ok:false,error:error.code?'Ошибка записи данных на диск':error.message});}
}
const esc = s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = v=>v==null?'—':Number(v).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
function block(q,result) {
 const input=get(q),rates=state.rates,area=result?result.S:null,cost=result?result.totalCost:null;
 const computed=calculate(input,rates,area,cost);
 const field=(label,k,hint='')=>`<div class="f8-field"><label for="fin-${k}">${label}</label><div class="f8-input"><input id="fin-${k}" aria-label="${label}" type="number" min="0" step="0.01" data-fin-input="${k}" value="${esc(input[k])}"><span>₽</span></div>${hint?`<small>${hint}</small>`:''}</div>`;
 const line=(label,k,tip)=>`<div class="f8-line" title="${tip}"><span>${label}</span><strong><span data-fin-out="${k}">${fmt(computed[k])}</span> ₽</strong></div>`;
 return `<section id="finance8" data-context="${esc(JSON.stringify([q.project,q.planning,q.vid]))}" data-area="${esc(area)}" data-cost="${esc(cost)}" data-agent="${rates.agent}" data-overhead="${rates.overhead}">
 <header class="f8-header"><div><h2>Стоимость квартиры</h2><p>Условия сделки и результат после вычета расходов</p></div><span class="f8-badge">Финансовый расчёт</span></header>
 <div class="f8-layout"><section class="f8-panel"><h3>Условия сделки</h3><p class="f8-muted">Введите суммы — результат обновится автоматически.</p>
 ${field('Стоимость квартиры по договору','sale')}${field('Первоначальный взнос','down')}${field('Субсидия','subsidy')}${field('Скидка','discount','Справочно · не учтена в итоге')}
 <div class="f8-actions"><button type="button" class="btn" id="fin-save">Сохранить данные</button><span id="fin-status" role="status"></span></div></section>
 <section class="f8-panel f8-results"><h3>Результат расчёта</h3><div class="f8-hero"><span>Итоговая стоимость квартиры</span><div><strong data-fin-out="net">${fmt(computed.net)}</strong><span> ₽</span></div></div>
 <div class="f8-meter"><span>Без отделки за 1 м²</span><strong><span data-fin-out="perM2">${fmt(computed.perM2)}</span> ₽/м²</strong></div>
 <h4>Что вычитается из стоимости</h4>
 <div class="f8-line"><span>Первоначальный взнос</span><strong><span data-fin-copy="down">${fmt(input.down||0)}</span> ₽</strong></div>
 <div class="f8-line"><span>Субсидия</span><strong><span data-fin-copy="subsidy">${fmt(input.subsidy||0)}</span> ₽</strong></div>
 ${line('Агентское вознаграждение','agent','(Стоимость по договору − первоначальный взнос) × ставка')}
 ${line('Накладные расходы','overhead','Ставка накладных расходов × площадь квартиры')}
 <div class="f8-line"><span>Себестоимость отделки</span><strong>${fmt(cost)} ₽</strong></div>
 <p class="f8-muted">Площадь: ${fmt(area)} м². Ставки редактируются во вкладке «Расчёт». При незаполненной стоимости или нулевой площади итог не рассчитывается.</p>
 </section></div></section>`;
}
const css=`
#finance8{margin:20px 14px;font:14px/1.45 Arial,sans-serif;color:#1e293b}
#finance8 *{box-sizing:border-box}
#finance8 .f8-header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:16px}
#finance8 h2,#finance8 h3,#finance8 h4{margin:0;color:#17354b;background:none;border:0;padding:0}
#finance8 h2{font-size:22px}#finance8 h3{font-size:17px}#finance8 h4{font-size:13px;margin:24px 0 8px}
#finance8 .f8-header p{margin:5px 0 0;color:#64748b}
#finance8 .f8-badge{background:#e8f2f4;color:#0a5a79;border-radius:20px;padding:6px 12px;font-size:12px;white-space:nowrap}
#finance8 .f8-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:20px;align-items:stretch}
#finance8 .f8-panel{min-width:0;padding:24px;background:#fff;border:1px solid #dce4eb;border-radius:14px}
#finance8 .f8-muted{font-size:12px;line-height:1.6;color:#64748b;margin:8px 0 20px}
#finance8 .f8-field{margin:18px 0}
#finance8 .f8-field label{display:block;text-align:right;font-size:13px;font-weight:600;color:#334155;margin-bottom:7px}
#finance8 .f8-input{position:relative}
#finance8 input[type=number]{display:block;width:100%;min-width:0;max-width:100%;padding:12px 36px 12px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#172b3a;font:600 17px/1.3 Arial,sans-serif;text-align:right;appearance:textfield;-moz-appearance:textfield}
#finance8 .f8-input>span{position:absolute;right:13px;top:50%;transform:translateY(-50%);color:#64748b}
#finance8 input::-webkit-inner-spin-button,#finance8 input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
#finance8 input:focus{outline:3px solid #c8e7ed;outline-offset:1px;border-color:#0a5a79;background:white}
#finance8 .f8-field small{display:block;text-align:right;color:#64748b;margin-top:5px;font-size:11px}
#finance8 .f8-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:24px}
#finance8 .f8-actions .btn{border:0;border-radius:8px;background:#0a5a79;color:white;padding:11px 16px;font-weight:600;cursor:pointer}
#finance8 #fin-status{font-size:12px;color:#475569}
#finance8 .f8-hero{margin-top:18px;padding:20px;background:#eef6f7;border:1px solid #d4e7ea;border-radius:10px;text-align:right}
#finance8 .f8-hero>span{font-size:13px;color:#43606b}
#finance8 .f8-hero>div{margin-top:8px;font-size:clamp(22px,2.3vw,32px);color:#0a4d62;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
#finance8 .f8-meter{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 0;border-bottom:1px solid #e2e8f0;font-size:13px}
#finance8 .f8-meter strong{text-align:right;font-size:17px;color:#17354b;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
#finance8 .f8-line{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid #eef2f6;font-size:13px}
#finance8 .f8-line>span{text-align:right;flex:1;color:#64748b}
#finance8 .f8-line strong{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
#finance8-rates input{max-width:100%;box-sizing:border-box;padding:9px;border:1px solid #cbd5e1;border-radius:7px;background:#f8fafc;text-align:right}
#finance8-rates label{display:inline-block;margin:8px}
@media(max-width:900px){#finance8 .f8-layout{grid-template-columns:minmax(0,1fr)}#finance8 .f8-panel{padding:18px}#finance8 .f8-header{align-items:flex-start}#finance8 .f8-badge{white-space:normal;text-align:right}}
@media(max-width:480px){#finance8{margin:16px 8px}#finance8 .f8-header{display:block}#finance8 .f8-badge{display:inline-block;margin-top:10px}#finance8 .f8-meter{align-items:flex-start;flex-direction:column}#finance8 .f8-line{gap:8px;flex-wrap:wrap}#finance8 .f8-hero>div{font-size:25px}}
`;

function rates() {return `<section class="card" id="finance8-rates"><h2>Финансовые ставки — роль 8</h2><label>Агентское вознаграждение, % <input type="number" min="0" max="100" step="any" id="fin-rate-agent" value="${state.rates.agent*100}"></label> <label>Накладные расходы, ₽/м² <input type="number" min="0" step="any" id="fin-rate-overhead" value="${state.rates.overhead}"></label><p class="hint">Общие ставки для финансового блока роли 8. Коэффициенты отделки не изменяются.</p><button class="btn" type="button" id="fin-rates-save">Сохранить ставки</button> <span id="fin-rates-status" role="status"></span></section>`;}
const client=`(function(){
 var box=document.getElementById('finance8');if(!box)return;
 var dirty=false;
 function number(value){if(value===''||value==null)return null;var n=Number(value);if(!Number.isFinite(n)||n<0)throw Error('Введите неотрицательное число');return n;}
 function input(){var values={};box.querySelectorAll('[data-fin-input]').forEach(function(el){if(el.validity.badInput)throw Error('Некорректное число');values[el.dataset.finInput]=number(el.value);});return values;}
 function status(text){document.getElementById('fin-status').textContent=text;}
 function recompute(){try{var values=input();var sale=values.sale,down=values.down||0,subsidy=values.subsidy||0;var area=number(box.dataset.area),cost=number(box.dataset.cost);box.querySelectorAll('[data-fin-copy]').forEach(function(el){el.textContent=(values[el.dataset.finCopy]||0).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});});var agentRate=number(box.dataset.agent), overheadRate=number(box.dataset.overhead);var out={agent:null,overhead:null,net:null,perM2:null};if(sale!==null&&area>0&&cost!==null&&agentRate!==null&&overheadRate!==null){out.agent=(sale-down)*agentRate;out.overhead=overheadRate*area;out.net=sale-down-subsidy-out.agent-out.overhead-cost;out.perM2=out.net/area;}Object.keys(out).forEach(function(k){box.querySelector('[data-fin-out="'+k+'"]').textContent=out[k]===null?'—':out[k].toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});});}catch(e){box.querySelectorAll('[data-fin-out]').forEach(function(el){el.textContent='—';});status(e.message);}}
 async function save(payload){var response=await fetch('./save-finance8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});var data=await response.json();if(!response.ok||!data.ok)throw Error(data.error||'Ошибка сохранения');}
 async function saveCase(){await save(Object.assign({kind:'case',context:JSON.parse(box.dataset.context)},input()));dirty=false;status('Сохранено');}
 box.addEventListener('input',function(e){if(e.target.matches('[data-fin-input]')){dirty=true;status('Не сохранено');recompute();}});
 document.getElementById('fin-save').onclick=function(){saveCase().catch(function(e){status(e.message);});};
 // Сохранить ввод перед пересчетом формы (проект/планировка/вид отделки).
 var form=document.getElementById('calc');if(form){var nativeSubmit=form.submit.bind(form);form.submit=function(){saveCase().then(nativeSubmit).catch(function(e){status(e.message);});};form.addEventListener('submit',function(e){e.preventDefault();form.submit();});}
 window.addEventListener('beforeunload',function(e){if(dirty){e.preventDefault();e.returnValue='';}});
 var ratesButton=document.getElementById('fin-rates-save');if(ratesButton)ratesButton.onclick=async function(){var output=document.getElementById('fin-rates-status');try{var a=document.getElementById('fin-rate-agent'),o=document.getElementById('fin-rate-overhead');if(!a.checkValidity()||!o.checkValidity())throw Error('Проверьте ставки');var agent=number(a.value),overhead=number(o.value);if(agent===null||overhead===null)throw Error('Заполните обе ставки');await save({kind:'rates',agent:agent/100,overhead:overhead});box.dataset.agent=agent/100;box.dataset.overhead=overhead;recompute();output.textContent='Ставки сохранены';}catch(e){output.textContent=e.message;}};
 recompute();
})();`;
module.exports={calculate,save,block,rates,client,css};
