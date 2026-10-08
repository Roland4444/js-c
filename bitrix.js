'use strict';
const crypto = require('node:crypto');
const sessions = new Map();
const domain = process.env.BITRIX_DOMAIN;
const ttl = 60 * 60 * 1000;
function identity(req, url) {
  const token = req.headers['x-app-session'] || url.searchParams.get('_session');
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) return null;
  return session.user;
}
async function authenticate(req, res) {
  const reply = (code, value) => { res.writeHead(code, {'Content-Type':'application/json', 'Cache-Control':'no-store'}); res.end(JSON.stringify(value)); };
  if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) return reply(503, {error:'Настройте BITRIX_DOMAIN на сервере'});
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 16384) return reply(413, {error:'Слишком большой запрос'}); }
    const input = JSON.parse(body);
    if (!input.access_token || input.domain !== domain) return reply(401, {error:'Неверный портал'});
    const response = await fetch('https://' + domain + '/rest/user.current.json', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({auth:input.access_token}), signal:AbortSignal.timeout(8000)
    });
    const data = await response.json();
    if (!response.ok || data.error || !data.result || !/^\d+$/.test(String(data.result.ID))) return reply(401, {error:'Bitrix не подтвердил пользователя'});
    for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
    const user = data.result;
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {expires:Date.now()+ttl, user:{id:String(user.ID), name:[user.NAME,user.LAST_NAME].filter(Boolean).join(' ')}});
    reply(200, {token});
  } catch (e) { reply(401, {error:'Не удалось проверить авторизацию Bitrix'}); }
}
const client = `<script>
(function(){
 var token=sessionStorage.getItem('calculator.session');
 var original=window.fetch;
 window.fetch=function(input, options){
   var target=new URL(typeof input==='string'?input:input.url,location.href);
   if(target.origin===location.origin){options=Object.assign({},options);var headers=new Headers(options.headers || (input instanceof Request?input.headers:undefined));if(token)headers.set('X-App-Session',token);options.headers=headers;}
   return original.call(window,input,options);
 };
 document.addEventListener('DOMContentLoaded',function(){
   document.querySelectorAll('form').forEach(function(form){var field=document.createElement('input');field.type='hidden';field.name='_session';field.value=token||'';form.appendChild(field);});
   if(new URL(location.href).searchParams.has('_session')){var clean=new URL(location.href);clean.searchParams.delete('_session');history.replaceState(null,'',clean);}
 });
})();
</script>`;
function bootstrap(install) {
 return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Вход через Bitrix24</title></head><body><p id="status">Подключение к Bitrix24…</p><script>
(function(){
 function fail(message){document.getElementById('status').textContent=message;}
 if(window.self===window.top){fail('Откройте калькулятор из приложения Bitrix24.');return;}
 var timer=setTimeout(function(){fail('Bitrix24 не ответил. Откройте приложение заново.');},10000);
 var sdk=document.createElement('script');sdk.src='https://api.bitrix24.com/api/v1/';sdk.onerror=function(){clearTimeout(timer);fail('Не удалось загрузить SDK Bitrix24.');};
 sdk.onload=function(){
 ${install ? "BX24.install(function(){BX24.installFinish();});" : ''}
 BX24.init(function(){
 BX24.callMethod('user.current',{},function(result){
 if(result.error()){clearTimeout(timer);fail('Не удалось получить пользователя Bitrix24.');return;}
 var user=result.data();var login=user.EMAIL||user.PERSONAL_PHONE||user.PHONE||user.LOGIN||user.ID;
 var auth=BX24.getAuth();if(!auth){clearTimeout(timer);fail('Нет авторизации Bitrix24.');return;}
 fetch('/auth/bitrix',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain:auth.domain,access_token:auth.access_token})}).then(function(r){return r.json();}).then(function(data){clearTimeout(timer);if(!data.token)throw new Error(data.error||'Ошибка авторизации');sessionStorage.setItem('calculator.session',data.token);var target=new URL(location.href);target.pathname='/';target.searchParams.delete('_session');target.searchParams.set('_session',data.token);location.replace(target.href);}).catch(function(e){clearTimeout(timer);fail(e.message);});
 });});};document.head.appendChild(sdk);
})();</script></body></html>`;
}
module.exports={identity,authenticate,bootstrap,client};
