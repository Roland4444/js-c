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
 const field=(label,k)=>`<tr><td>${label}</td><td><input type="number" min="0" step="0.01" data-fin-input="${k}" value="${esc(input[k])}"></td></tr>`;
 const out=(label,k)=>`<tr><td>${label}</td><td data-fin-out="${k}" class="num">${fmt(computed[k])}</td></tr>`;
 return `<section class="card" id="finance8" data-context="${esc(JSON.stringify([q.project,q.planning,q.vid]))}" data-area="${esc(area)}" data-cost="${esc(cost)}" data-agent="${rates.agent}" data-overhead="${rates.overhead}"><h2>Стоимость квартиры — финансовый расчёт</h2>
 <table class="detail"><tbody>${field('Стоимость квартиры по договору, ₽','sale')}${field('Сумма первоначального взноса, ₽','down')}${field('Сумма субсидии, ₽','subsidy')}${out('Агентское вознаграждение, ₽','agent')}${out('Накладные расходы, ₽','overhead')}${field('Скидка, ₽ (справочно, в итог не включена)','discount')}
 <tr><td>Общая себестоимость работы/пакета отделки, ₽</td><td class="num">${fmt(cost)}</td></tr>${out('Итоговая стоимость квартиры после вычета расходов, ₽','net')}${out('Стоимость квартиры без отделки, ₽/м²','perM2')}</tbody></table>
 <p class="hint">Пустые взнос и субсидия считаются нулём. Без стоимости квартиры или при нулевой/неизвестной площади итог не рассчитывается. Себестоимость отделки вычитается один раз.</p><button type="button" class="btn" id="fin-save">Сохранить финансовые данные</button> <span id="fin-status" role="status"></span></section>`;
}
function rates() {return `<section class="card" id="finance8-rates"><h2>Финансовые ставки — роль 8</h2><label>Агентское вознаграждение, % <input type="number" min="0" max="100" step="any" id="fin-rate-agent" value="${state.rates.agent*100}"></label> <label>Накладные расходы, ₽/м² <input type="number" min="0" step="any" id="fin-rate-overhead" value="${state.rates.overhead}"></label><p class="hint">Общие ставки для финансового блока роли 8. Коэффициенты отделки не изменяются.</p><button class="btn" type="button" id="fin-rates-save">Сохранить ставки</button> <span id="fin-rates-status" role="status"></span></section>`;}
const client=`(function(){
 var box=document.getElementById('finance8');if(!box)return;
 var dirty=false;
 function number(value){if(value===''||value==null)return null;var n=Number(value);if(!Number.isFinite(n)||n<0)throw Error('Введите неотрицательное число');return n;}
 function input(){var values={};box.querySelectorAll('[data-fin-input]').forEach(function(el){if(el.validity.badInput)throw Error('Некорректное число');values[el.dataset.finInput]=number(el.value);});return values;}
 function status(text){document.getElementById('fin-status').textContent=text;}
 function recompute(){try{var values=input();var sale=values.sale,down=values.down||0,subsidy=values.subsidy||0;var area=number(box.dataset.area),cost=number(box.dataset.cost);var agentRate=number(box.dataset.agent), overheadRate=number(box.dataset.overhead);var out={agent:null,overhead:null,net:null,perM2:null};if(sale!==null&&area>0&&cost!==null&&agentRate!==null&&overheadRate!==null){out.agent=(sale-down)*agentRate;out.overhead=overheadRate*area;out.net=sale-down-subsidy-out.agent-out.overhead-cost;out.perM2=out.net/area;}Object.keys(out).forEach(function(k){box.querySelector('[data-fin-out="'+k+'"]').textContent=out[k]===null?'—':out[k].toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});});}catch(e){box.querySelectorAll('[data-fin-out]').forEach(function(el){el.textContent='—';});status(e.message);}}
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
module.exports={calculate,save,block,rates,client};
