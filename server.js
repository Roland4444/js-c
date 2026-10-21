'use strict';
/*
 * «Калькулятор отделки» — внутренний веб-калькулятор пакета отделки.
 * Рантайм: node20, без внешних зависимостей (только node:http/fs/url).
 * Вкладки как листы книги Excel: Калькулятор / Расчёт / Справочник.
 * Данные: data.json (извлечены из «Калькулятор отделки.xlsx») + справочник СПРАВ.
 * Ролевой доступ по фамилиям (заголовки X-Vibe-User-Name-Encoded / X-Vibe-User-Name).
 * Запрет выгрузки: только отрисованный HTML, без сырых JSON-эндпоинтов наружу,
 * копирование/печать/контекстное меню отключены.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const bitrix = require('./bitrix');
const finance8 = require('./finance8');
const DIR = process.env.DATA_DIR || __dirname;
const PORT = process.env.PORT || 3000;

// ---------- данные ----------
let BASE = JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8'));
// Полные имена «Имя Фамилия» по id пользователя (для заголовка) — резолв по x-vibe-user-id
let USERS = {};
try { USERS = JSON.parse(fs.readFileSync(path.join(DIR, 'users.json'), 'utf8')); } catch (e) { USERS = {}; }
const EDITED_FILE = path.join(DIR, 'data.edited.json');
let EDITED = {};
if (fs.existsSync(EDITED_FILE)) {
  try { EDITED = JSON.parse(fs.readFileSync(EDITED_FILE, 'utf8')); } catch (e) { EDITED = {}; }
}
function currentData() {
  const d = JSON.parse(JSON.stringify(BASE));
  if (EDITED.compositions) {
    for (const vid of Object.keys(EDITED.compositions)) {
      if (d.compositions[vid]) {
        for (const ed of EDITED.compositions[vid]) {
          const row = d.compositions[vid].find(r => r.no === ed.no);
          if (row) {
            if (ed.name != null) row.name = ed.name;
            if (ed.price != null) row.price = ed.price;
            if (ed.volume != null) row.volumeOverride = ed.volume;
            row.approx = row.approx || ed.approx;
          }
        }
      }
    }
  }
  applyMatrixEdits(d, MATRIX_ED); // правки роли 6 (матрицы)
  return d;
}
function persistEdited() {
  try { fs.writeFileSync(EDITED_FILE, JSON.stringify(EDITED, null, 1)); } catch (e) {}
}

// ---------- матрицы (роль 6): правки объёмов, планировок, строк работ ----------
// Хранятся отдельно от EDITED (роль 3) и SPRAV (роль 4), чтобы не смешивать области.
// Дерево-структура: projects.<проект>.{params, volumes, wash} и
//                  compositions.<вид>.rows[].  null  в volumes/wash/params = удалить ключ.
const MATRIX_FILE = path.join(DIR, 'matrix.edited.json');
let MATRIX_ED = {};
try { if (fs.existsSync(MATRIX_FILE)) MATRIX_ED = JSON.parse(fs.readFileSync(MATRIX_FILE, 'utf8')); } catch (e) { MATRIX_ED = {}; }
function persistMatrix() { try { fs.writeFileSync(MATRIX_FILE, JSON.stringify(MATRIX_ED, null, 1)); } catch (e) {} }
const PARAM_KEYS = new Set(['S_ap','S_useful','S_SU','rooms','S_walls_total','S_walls_noSU','S_walls_SU','perimeter','plinth']);
const WASH_KEYS = new Set(['perim','doors','outlets','switches','lights']);
const ROW_KEYS = new Set(['code','name','rule','price','comment']);
// Накладывает правки роли 6 на объект данных (после правок роли 3).
function applyMatrixEdits(d, m) {
  if (!m || (!m.projects && !m.newProjects && !m.replaceProjects && !m.deletedProjects && !m.compositions)) return;
  for (const proj of Object.keys(m.projects || {})) {
    if (!d.projects[proj]) continue;
    const pe = m.projects[proj] || {};
    // params (включая новые планировки)
    if (pe.params) for (const pl of Object.keys(pe.params)) {
      const src = pe.params[pl];
      const target = d.projects[proj].params[pl] || (d.projects[proj].params[pl] = {});
      for (const k of Object.keys(src)) {
        const v = src[k];
        if (v == null || v === '') delete target[k]; else target[k] = Number(v);
      }
    }
    // wash
    if (pe.wash) for (const pl of Object.keys(pe.wash)) {
      const src = pe.wash[pl];
      const target = d.projects[proj].wash[pl] || (d.projects[proj].wash[pl] = {});
      for (const k of Object.keys(src)) {
        const v = src[k];
        if (v == null || v === '') delete target[k]; else target[k] = Number(v);
      }
    }
    // volumes (null = удалить коэффициент)
    if (pe.volumes) for (const code of Object.keys(pe.volumes)) {
      const vals = pe.volumes[code] || {};
      const target = d.projects[proj].volumes[code] || (d.projects[proj].volumes[code] = {});
      for (const pl of Object.keys(vals)) {
        const v = vals[pl];
        if (v == null || v === '') delete target[pl]; else target[pl] = Number(v);
      }
    }
  }
  // строки работ в составах (замена по `no` или добавление новых)
  if (m.compositions) for (const vid of Object.keys(m.compositions)) {
    if (!d.compositions[vid]) continue;
    const rows = (m.compositions[vid] && m.compositions[vid].rows) || [];
    for (const r of rows) {
      const idx = d.compositions[vid].findIndex(x => x.no === r.no);
      if (idx >= 0) d.compositions[vid][idx] = Object.assign({}, d.compositions[vid][idx], r);
      else d.compositions[vid].push(r);
    }
  }
  // новые проекты (импорт роли 6): добавляются в data.projects + цена м² в projects_price_m2
  if (m.newProjects) for (const name of Object.keys(m.newProjects)) {
    if (!d.projects[name]) d.projects[name] = JSON.parse(JSON.stringify(m.newProjects[name]));
    if (m.projectPrices && m.projectPrices[name] != null) d.projects_price_m2[name] = Number(m.projectPrices[name]);
  }
  // замена существующих проектов (импорт роли 6, вариант B): ОБНОВЛЕНИЕ-СЛИЯНИЕ.
  // Применяются только заполненные ячейки файла; незаполненные (пустые) не затирают
  // существующие данные — иначе пустой лист «Санузел» обнуляет розетки/светильники.
  if (m.replaceProjects) for (const name of Object.keys(m.replaceProjects)) {
    const src = m.replaceProjects[name];
    const cur = d.projects[name] || {};
    const out = Object.assign({}, cur, JSON.parse(JSON.stringify(src)));
    // params: только ключи из файла
    if (isObj(src.params)) {
      out.params = JSON.parse(JSON.stringify(cur.params || {}));
      for (const pl of Object.keys(src.params)) {
        const tgt = out.params[pl] || (out.params[pl] = {});
        for (const k of Object.keys(src.params[pl])) {
          const v = src.params[pl][k];
          if (v != null && v !== '') tgt[k] = Number(v); else delete tgt[k];
        }
      }
    }
    // wash: только ключи из файла (пустые ячейки не обнуляют outlets/switches/lights)
    if (isObj(src.wash)) {
      out.wash = JSON.parse(JSON.stringify(cur.wash || {}));
      for (const pl of Object.keys(src.wash)) {
        const tgt = out.wash[pl] || (out.wash[pl] = {});
        for (const k of Object.keys(src.wash[pl])) {
          const v = src.wash[pl][k];
          if (v != null && v !== '') tgt[k] = Number(v); else delete tgt[k];
        }
      }
    }
    // volumes: только заполненные коэффициенты
    if (isObj(src.volumes)) {
      out.volumes = JSON.parse(JSON.stringify(cur.volumes || {}));
      for (const code of Object.keys(src.volumes)) {
        const vals = src.volumes[code] || {};
        const tgt = out.volumes[code] || (out.volumes[code] = {});
        for (const pl of Object.keys(vals)) {
          const v = vals[pl];
          if (v == null || v === '' || isNaN(Number(v))) delete tgt[pl]; else tgt[pl] = Number(v);
        }
      }
    }
    d.projects[name] = out;
    if (m.projectPrices && m.projectPrices[name] != null) d.projects_price_m2[name] = Number(m.projectPrices[name]);
  }
  // удаление проектов (роль 6): tombstone по имени
  if (Array.isArray(m.deletedProjects)) for (const name of m.deletedProjects) { delete d.projects[name]; delete d.projects_price_m2[name]; delete (m.newProjects || {})[name]; delete (m.replaceProjects || {})[name]; }
}

// ---------- импорт xlsx проекта (мини-парсер, без внешних зависимостей) ----------
// xlsx = ZIP-контейнер XML; читаем через встроенный node:zlib (inflateRawSync).
function unzipXlsx(data) {
  const entries = {};
  let eocd = -1;
  for (let i = data.length - 22; i >= 0; i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Файл не является xlsx (ZIP-подпись не найдена)');
  const count = data.readUInt16LE(eocd + 10);
  let off = data.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && off + 46 <= data.length; n++) {
    if (data.readUInt32LE(off) !== 0x02014b50) break;
    const method    = data.readUInt16LE(off + 10);
    const csize     = data.readUInt32LE(off + 20);
    const nl        = data.readUInt16LE(off + 28);
    const el        = data.readUInt16LE(off + 30);
    const cl        = data.readUInt16LE(off + 32);
    const lho       = data.readUInt32LE(off + 42);
    const name      = data.toString('utf8', off + 46, off + 46 + nl);
    const lnameLen  = data.readUInt16LE(lho + 26);
    const lextraLen = data.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnameLen + lextraLen;
    const comp      = data.subarray(dataStart, dataStart + csize);
    entries[name]   = method === 8 ? zlib.inflateRawSync(comp) : comp;
    off += 46 + nl + el + cl;
  }
  return entries;
}
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    let s = '';
    const tRe = /<t\b[^>]*>([^<]*)<\/t>|<t\b[^>]*\/>/g;
    let tm;
    while ((tm = tRe.exec(m[1])) !== null) if (tm[1] != null) s += tm[1];
    out.push(s);
  }
  return out;
}
function stripTags(x) { return String(x).replace(/<[^>]*>/g, ''); }
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function parseSheetXml(xml, shared) {
  if (!xml) return [];
  const rows = {};
  const cellRe = /<c\b[^>]*?(?:\/>|>.*?<\/c>)/gs;
  let m;
  while ((m = cellRe.exec(xml)) !== null) {
    const tag = m[0];
    const rm = /r="([A-Z]+)(\d+)"/.exec(tag);
    if (!rm) continue;
    const col = rm[1], row = Number(rm[2]);
    const tm = /t="([^"]*)"/.exec(tag);
    const t = tm ? tm[1] : '';
    const vm = /<v>([\s\S]*?)<\/v>/.exec(tag);
    const v = vm ? vm[1] : '';
    let value;
    if (t === 's') value = (shared[Number(v)] != null) ? decodeEntities(shared[Number(v)]) : '';
    else if (t === 'inlineStr') {
      const ism = /<is>([\s\S]*?)<\/is>/.exec(tag);
      value = ism ? decodeEntities(stripTags(ism[1])) : '';
    }
    else value = decodeEntities(v);
    rows[row] = rows[row] || {};
    rows[row][col] = String(value);
  }
  return Object.keys(rows).map(Number).sort((a, b) => a - b).map(r => ({ row: r, cells: rows[r] }));
}
function xlsxSheets(buf) {
  const entries = unzipXlsx(buf);
  const wb = entries['xl/workbook.xml'] ? entries['xl/workbook.xml'].toString('utf8') : '';
  const relXml = entries['xl/_rels/workbook.xml.rels'] ? entries['xl/_rels/workbook.xml.rels'].toString('utf8') : '';
  const targetById = {};
  // порядок атрибутов в rels может быть любым: разбираем теги целиком
  const relTags = relXml.match(/<Relationship\b[^>]*>/g) || [];
  for (const tag of relTags) {
    const id = /Id="(rId\d+)"/.exec(tag);
    const t = /Target="([^"]+)"/.exec(tag);
    if (id && t) targetById[id[1]] = t[1];
  }
  const shared = parseSharedStrings(entries['xl/sharedStrings.xml'] ? entries['xl/sharedStrings.xml'].toString('utf8') : '');
  const sheetRe = /<sheet\b[^>]*?(?:name="([^"]*)"[^>]*?r:id="(rId\d+)"|r:id="(rId\d+)"[^>]*?name="([^"]*)")/g;
  const out = [];
  let m;
  while ((m = sheetRe.exec(wb)) !== null) {
    const name = m[1] || m[4];
    const rid = m[2] || m[3];
    let tgt = targetById[rid];
    if (tgt) {
      if (tgt.startsWith('/')) tgt = tgt.slice(1);
      if (!tgt.startsWith('xl/')) tgt = 'xl/' + tgt;
      const xml = entries[tgt] ? entries[tgt].toString('utf8') : null;
      out.push({ name, rows: parseSheetXml(xml, shared) });
    }
  }
  return out;
}
function cellNum(v) {
  if (v == null || String(v).trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function importProjectFromXlsx(buf) {
  const sheets = xlsxSheets(buf);
  const byName = {};
  for (const s of sheets) byName[s.name.trim()] = s;
  const sheetKey = k => Object.keys(byName).find(n => n.toLowerCase().includes(k.toLowerCase())) || null;
  // --- лист Проект: вертикальный список Поле|Значение|Комментарий → projMap по первому слову ---
  const projMap = {};
  const projKey = sheetKey('Проект');
  if (projKey) for (const row of byName[projKey].rows) {
    const k = row.cells['A'] != null ? String(row.cells['A']).trim().toLowerCase() : '';
    if (!k) continue;
    const word = k.split(/\s+/)[0];
    if (row.cells['B'] != null) projMap[word] = String(row.cells['B']).trim();
  }
  const name = projMap['название'] || '';
  if (!name) throw new Error('Не заполнено «Название проекта» (лист Проект)');
  // --- лист Параметры: A=планировка, B..J = 9 параметров (позиции фиксированы) ---
  const params = {};
  const PK = ['rooms', 'S_ap', 'S_useful', 'S_SU', 'S_walls_total', 'S_walls_noSU', 'S_walls_SU', 'perimeter', 'plinth'];
  const paramKey = sheetKey('Параметры');
  if (paramKey) for (const row of byName[paramKey].rows) {
    if (row.row < 2) continue;
    const pl = row.cells['A']; if (!pl || !String(pl).trim()) continue;
    const rec = {};
    PK.forEach((k, i) => { const v = cellNum(row.cells[String.fromCharCode(66 + i)]); if (v !== undefined) rec[k] = v; });
    if (Object.keys(rec).length) params[String(pl).trim()] = rec;
  }
  if (!Object.keys(params).length) throw new Error('Нет планировок в листе «Параметры»');
  // --- лист Объёмы: распознаём колонки по шапке (B=ед, C=материал, далее планировки) ---
  const volumes = {}, units = {}, materials = {};
  const volKey = sheetKey('Объёмы');
  if (volKey) {
    const sh = byName[volKey];
    const header = (sh.rows.find(r => r.row === 1) || { cells: {} }).cells;
    const isMetadata = t => { t = t.toLowerCase(); return t === 'код' || t === 'код работы' || t.includes('ед') || t.includes('мат'); };
    const planCols = [];
    let unitCol = '', matCol = '';
    for (let i = 0; i < 60; i++) {
      const L = String.fromCharCode(65 + i);
      const hv = header[L];
      if (hv == null || !String(hv).trim()) continue;
      const htoken = String(hv).trim();
      if (htoken.startsWith('(') || htoken.startsWith('…') || htoken.startsWith('...')) continue;
      if (isMetadata(htoken)) { if (!unitCol && htoken.toLowerCase().includes('ед')) unitCol = L; if (!matCol && htoken.toLowerCase().includes('мат')) matCol = L; continue; }
      planCols.push({ L, name: htoken });
    }
    for (const row of sh.rows) {
      if (row.row < 2) continue;
      const code = row.cells['A']; if (!code || !String(code).trim()) continue;
      const codeS = String(code).trim();
      if (unitCol && row.cells[unitCol] != null && String(row.cells[unitCol]).trim()) units[codeS] = String(row.cells[unitCol]).trim();
      if (matCol && row.cells[matCol] != null && String(row.cells[matCol]).trim()) materials[codeS] = String(row.cells[matCol]).trim();
      const rec = volumes[codeS] = volumes[codeS] || {};
      for (const pc of planCols) { const v = cellNum(row.cells[pc.L]); if (v !== undefined) rec[pc.name] = v; }
    }
  }
  // --- лист Санузел: A=планировка, B..F = perim/doors/outlets/switches/lights ---
  const wash = {};
  const WK = ['perim', 'doors', 'outlets', 'switches', 'lights'];
  const washKey = sheetKey('Санузел');
  if (washKey) for (const row of byName[washKey].rows) {
    if (row.row < 2) continue;
    const pl = row.cells['A']; if (!pl || !String(pl).trim()) continue;
    const rec = {};
    WK.forEach((k, i) => { const v = cellNum(row.cells[String.fromCharCode(66 + i)]); if (v !== undefined) rec[k] = v; });
    if (Object.keys(rec).length) wash[String(pl).trim()] = rec;
  }
  // --- сборка блока проекта ---
  const block = { class: projMap['class'] || 'Комфорт', params, volumes, wash, units, materials };
  if (projMap['days'] !== undefined && projMap['days'] !== '') { const n = Number(projMap['days']); if (Number.isFinite(n)) block.days = n; }
  if (projMap['ввод'] !== undefined && projMap['ввод'] !== '') block.ввод = projMap['ввод'];
  const price = (projMap['price_m2'] !== undefined && projMap['price_m2'] !== '') ? Number(projMap['price_m2']) : undefined;
  return { name, block, price: Number.isFinite(price) ? price : undefined };
}

// ---------- справочник: правки роли 4 (стоимости работы/пакета) ----------
const SPRAV_FILE = path.join(DIR, 'sprav.edited.json');
let SPRAV_ED = {};
try { if (fs.existsSync(SPRAV_FILE)) SPRAV_ED = JSON.parse(fs.readFileSync(SPRAV_FILE, 'utf8')); } catch (e) { SPRAV_ED = {}; }
function persistSprav() { try { fs.writeFileSync(SPRAV_FILE, JSON.stringify(SPRAV_ED, null, 1)); } catch (e) {} }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function mergeArray(arr, over) {
  for (const ik of Object.keys(over || {})) {
    const idx = Number(ik);
    if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) continue;
    const sub = over[ik];
    if (sub !== null && (isObj(sub) || Array.isArray(sub))) {
      arr[idx] = (Array.isArray(arr[idx]) || isObj(arr[idx])) ? mergeDeep(JSON.parse(JSON.stringify(arr[idx])), sub) : sub;
    } else {
      arr[idx] = sub;
    }
  }
  return arr;
}
function mergeDeep(src, over) {
  const out = JSON.parse(JSON.stringify(src));
  for (const k of Object.keys(over || {})) {
    const ov = over[k];
    if (ov === null || ov === undefined || ov === '') continue;
    if (Array.isArray(out[k]) && isObj(ov)) { mergeArray(out[k], ov); }
    else if (isObj(ov) && isObj(out[k])) out[k] = mergeDeep(out[k], ov);
    else out[k] = ov;
  }
  return out;
}
function currentSprav() { return mergeDeep(СПРАВ, SPRAV_ED); }

// ---------- матрица К (роль 6): коэффициенты ценообразования К1..К4 ----------
// Полный аналог листа «Матрица К» книги Excel: К1 сценарий, К2 площадь, К3 срок, К4 рентабельность.
// К общий = К1 × К2 × К3 × К4; цена продажи = себестоимость × К общий.
const MATRIXK_FILE = path.join(DIR, 'matrixk.edited.json');
let MATRIXK_ED = {};
try { if (fs.existsSync(MATRIXK_FILE)) MATRIXK_ED = JSON.parse(fs.readFileSync(MATRIXK_FILE, 'utf8')); } catch (e) { MATRIXK_ED = {}; }
function persistMatrixK() { try { fs.writeFileSync(MATRIXK_FILE, JSON.stringify(MATRIXK_ED, null, 1)); } catch (e) {} }
const МАТРИЦАК = {
  k1: { 'ДДУ': 1, 'ДКП': 1.1, 'Договор подряда': 1.15 },
  k2: [
    { label: '< 35 м²', upper: 34.999, k: 1.08 },
    { label: '35–50 м²', upper: 50, k: 1.04 },
    { label: '50–70 м²', upper: 70, k: 1.0 },
    { label: '70–90 м²', upper: 90, k: 0.97 },
    { label: '> 90 м²', upper: 99999, k: 0.94 }
  ],
  k3: [
    { label: '0 лет', upper: 0, k: 1 },
    { label: '1 год', upper: 1, k: 1.08 },
    { label: '2 года', upper: 2, k: 1.15 }
  ],
  k4: { 'Да': 1, 'Нет': 1.05 }
};
function currentMatrixK() { return mergeDeep(МАТРИЦАК, MATRIXK_ED); }
function kTotal(mk, scenario, S, srok, rent) {
  mk = mk || МАТРИЦАК;
  const k1 = (mk.k1 && mk.k1[scenario] != null) ? mk.k1[scenario] : 1;
  let k2 = 1;
  if (Array.isArray(mk.k2)) for (const r of mk.k2) { if (S <= r.upper) { k2 = r.k; break; } }
  let k3 = 1;
  if (Array.isArray(mk.k3)) for (const r of mk.k3) { if (String(srok) === r.label) { k3 = r.k; break; } }
  const rentKey = /^Нет/i.test(String(rent)) ? 'Нет' : 'Да';
  const k4 = (mk.k4 && mk.k4[rentKey] != null) ? mk.k4[rentKey] : 1;
  return { k1, k2, k3, k4, total: k1 * k2 * k3 * k4 };
}

// ---------- справочник (из листа «Справочник» книги Excel) ----------
const СПРАВ = {
  налогПрибыль: 0.25,
  инфляция: 0.10,
  маржаДду: 0.18,
  маржаПодряд: 0.25,
  классДду:   {'Эконом':0.80,'Комфорт':1,'Комфорт+':1.10,'Бизнес':1.18},
  классПодряд:{'Эконом':0.90,'Комфорт':1,'Комфорт+':1.12,'Бизнес':1.25},
  площДду:    [[35,1.00],[55,0.97],[80,0.94]],
  площПодряд: [[35,1.08],[55,1.04],[80,1.00]],
  рынок: {'Эконом':25000,'Комфорт':28500,'Комфорт+':33000,'Бизнес':37000},
  предчистоваяРынок: 6500,
  проекты: {'RED/SKY':'Комфорт','Оливия':'Комфорт+','Семейный':'Комфорт','Scandi':'Комфорт','Tetris':'Эконом','Okland':'Комфорт','ДУО':'Комфорт'}
};
function areaCoeff(S, rows) {
  for (const [up,k] of rows) if (S <= up) return k;
  return rows[rows.length-1][1];
}

// ---------- роли (capabilities) ----------
// Роли приходят с сервера https://romach.space/lisp/excel-roles в виде
//   {"1":[id,...], "2":[...], "3":[...], "4":[...]}
// где ключ = номер роли (возможность), значение = список Bitrix user id.
// Каждый запрос/открытие делает запрос к серверу; при успехе ответ
// ПЕРЕЗАПИСЫВАЕТ конфиг roles.json. При недоступности сервера роли
// читаются из roles.json. Если пользователь в нескольких ролях — его
// возможности СУММИРУЮТСЯ (множество номеров ролей).
// Семантика ролей: 1 — просмотр верхней части; 2 — просмотр детализации
// (Состав отделки); 3 — админ материалов/себестоимости; 4 — админ стоимости
// работы/пакета.
const ROLES_URL = process.env.ROLES_URL || '';
const ROLES_FILE = path.join(DIR, 'roles.json');
// Роль 8 — расширенный финансовый блок; назначается только через роли, без принудительных ID.
const ROLES_DEF = { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [], "8": [] };
// Роль 5 (debug): включает выделение текста, копирование и красную кнопку «Скопировать»
// (дамп таблицы «как в Excel» для сверки). Назначается серверно — не зависит от внешнего
// сервиса ролей, чтобы его нельзя было затереть удалённым ответом.
const DEBUG_USERS = [336];
// Роль 6 (матрицы): редактирование матриц объёмов по проектам, добавление планировок
// и строк работ в составах отделки. Тоже назначается серверно (как роль 5) — не зависит
// от внешнего сервиса ролей. Дополнительно роль 6 можно назначать через внешний сервис
// ролей как возможность "6" (множество включает и серверный, и внешний пути).
const MATRIX_USERS = [336];
// Роль 7 (учредители): показывает в разделе «Калькулятор» дополнительный блок
// «СТОИМОСТЬ КВАРТИРЫ» (стоимость продажи квартиры по договору, цена без отделки
// ₽/1 кв м, сумма первоначального взноса). Назначается серверно (как роли 5, 6);
// дополнительно можно выдавать через внешний сервис ролей как возможность "7".
const FOUNDER_USERS = [336];

// ---------- учредители (роль 7): редактируемые значения блока «СТОИМОСТЬ КВАРТИРЫ» ----------
// Продажа и взнос — вводимые; «цена без отделки ₽/1 кв м» — вычисляемая. Хранятся в founder.json.
const FOUNDER_FILE = path.join(DIR, 'founder.json');
let FOUNDER_V = { sale: 9576000, down: 1000000 };
try { if (fs.existsSync(FOUNDER_FILE)) FOUNDER_V = JSON.parse(fs.readFileSync(FOUNDER_FILE, 'utf8')); } catch (e) { FOUNDER_V = { sale: null, down: null }; }
function persistFounder() { try { fs.writeFileSync(FOUNDER_FILE, JSON.stringify(FOUNDER_V, null, 1)); } catch (e) {} }

function readRolesFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
    return normRoles(raw && raw.capabilities ? raw.capabilities : raw);
  } catch (e) { return normRoles(ROLES_DEF); }
}
function writeRolesFile(map) {
  try { fs.writeFileSync(ROLES_FILE, JSON.stringify({ capabilities: map }, null, 1)); } catch (e) {}
}
function normRoles(m) {
  const out = {};
  if (!m || typeof m !== 'object') return JSON.parse(JSON.stringify(ROLES_DEF));
  for (const k of Object.keys(m)) {
    const arr = Array.isArray(m[k]) ? m[k].map(Number).filter(Boolean) : [];
    out[k] = arr;
  }
  return Object.keys(out).length ? out : JSON.parse(JSON.stringify(ROLES_DEF));
}
async function loadRoles() {
  if (!ROLES_URL) return readRolesFile();
  // попытка получить роли с сервера
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 4000);
  try {
    const resp = await fetch(ROLES_URL, { signal: ctrl.signal });
    clearTimeout(to);
    if (resp.ok) {
      const data = await resp.json();
      const map = normRoles(data && data.capabilities ? data.capabilities : data);
      writeRolesFile(map); // перезаписываем конфиг данными сервера
      return map;
    }
  } catch (e) { /* сервер недоступен */ }
  clearTimeout(to);
  return readRolesFile(); // fallback на файл конфига
}
function capsFor(map, idNum) {
  const set = new Set();
  if (Number.isNaN(idNum)) return set;
  for (const k of Object.keys(map)) {
    if (Array.isArray(map[k]) && map[k].includes(idNum)) set.add(String(k));
  }
  return set;
}
function roleFromCaps(caps, idNum, name) {
  const has = r => caps.has(String(r));
  const admin = has('3') || has('4');
  const editMatrix = has('6');
  const founder = has('7');
  const finance8 = has('8');
  const canViewDetail = has('2') || admin || editMatrix;
  const editMaterials = has('3');
  const editCost = has('4');
  const debug = has('5');
  let level;
  if (editMatrix) level = 6; // роль 6 — админ матриц (объёмы, планировки, строки работ)
  else if (finance8) level = 8;
  else if (founder) level = 7; // роль 7 — учредители (блок «СТОИМОСТЬ КВАРТИРЫ» в Калькуляторе)
  else if (admin) level = 3;
  else if (has('2')) level = 2;
  else if (has('1')) level = 1;
  else if (has('5')) level = 5;
  else level = 0; // нет прав → отказ в доступе
  const denied = level === 0;
  return { level, denied, admin, debug, founder, finance8, caps: [...caps], canViewDetail, editMaterials, editCost, editMatrix, name: (name || (Number.isNaN(idNum) ? null : String(idNum))), id: idNum };
}
function accessDeniedPage(role) {
  const who = role && role.name ? esc(role.name) : 'Пользователь';
  const whoId = (role && !Number.isNaN(role.id)) ? ` (id ${role.id})` : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">${bitrix.client}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Нет доступа — Калькулятор отделки</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#F1F4F7;color:#191919;font:15px/1.5 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;
  display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.den{background:#fff;border:1px solid #C9D3E8;border-radius:10px;max-width:440px;width:100%;
  padding:28px 30px;box-shadow:0 2px 10px rgba(20,30,60,.08);text-align:center}
.den .ico{font-size:40px}
.den h1{font-size:18px;color:#0A5A79;margin:12px 0 6px}
.den p{color:#595959;font-size:13px;margin:6px 0}
.den .who{color:#191919;font-weight:600}
.den .foot{margin-top:18px;color:#A0A0A0;font-size:11px}
</style></head>
<body><div class="den">
  <div class="ico">🚫</div>
  <h1>Нет доступа</h1>
  <p>Пользователь <span class="who">${who}${whoId}</span> не входит в роли «Калькулятора отделки».</p>
  <p>Доступ к приложению ограничен ролевой моделью Bitrix24. Если вы считаете, что доступ нужен — обратитесь к администратору калькулятора.</p>
  <div class="foot">Внутренний сервис. Доступ только для сотрудников с назначенной ролью.</div>
</div></body></html>`;
}

// ---------- расчёт ----------
function volCoeff(pr, code, plan) {
  const v = pr.volumes[code];
  return v && v[plan] != null ? v[plan] : null;
}
function bathPerim(ssu) {
  if (!ssu || ssu <= 0) return 0;
  const a = Math.sqrt(ssu);
  return +(2 * (1.4 * a + a / 1.4)).toFixed(2);
}
const r2 = v => Math.round(v * 100) / 100;
const rub = v => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
const rub0 = v => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(v);
const rub2 = v => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v);

function compute(data, project, planning, vid, scenario, srok, rent, dateStr) {
  const pr = data.projects[project];
  const p = pr && pr.params[planning];
  const comp = data.compositions[vid];
  if (!pr || !p || !comp) return null;
  const S = p.S_ap;
  const wash = (pr.wash || {})[planning] || {};
  const hasPrices = comp.some(r => r.price != null);
  const rows = comp.map((w, i) => {
    const code = w.code;
    const unit = (pr.units[code] || '').replace(/\./g, '');
    const material = pr.materials[code] || '';
    let volume = null, approx = false, zone;
    const rule = w.rule || 'FULL';
    const isCount = (unit === 'шт' || unit === 'компл');
    if (rule === 'FULL') {
      zone = 'Квартира';
      if (isCount) {
        volume = volCoeff(pr, code, planning);
        if (volume == null) { volume = 1; approx = true; }
      } else {
        const c = volCoeff(pr, code, planning);
        volume = (c == null ? 1 : c) * S;
        if (c == null) approx = true;
        // Excel: в «Предчистовой» и «Предчистовой плюс» стяжка FL-001 считается
        // с вычетом площади санузла: Q = коэфф × (S − S_SU). В ПРО/Чистовой — без вычета.
        if (code === 'FL-001' && (vid === 'Предчистовая' || vid === 'Предчистовая плюс')) {
          volume = (c == null ? 1 : c) * (S - (p.S_SU || 0));
        }
      }
    } else if (rule === 'BATH_FLOOR') { volume = p.S_SU || 0; zone = 'Санузел'; }
    else if (rule === 'BATH_WALL') { volume = p.S_walls_SU || 0; zone = 'Санузел'; }
    else if (rule === 'BATH_CEILING') { volume = p.S_SU || 0; zone = 'Санузел'; }
    else if (rule === 'BATH_PERIMETER') { volume = wash.perim != null ? wash.perim : (bathPerim(p.S_SU) || 0); zone = 'Санузел'; }
    else if (rule === 'BATH_DOORS') { volume = wash.doors != null ? wash.doors : 1; zone = 'Санузел'; }
    else if (rule === 'BATH_OUTLETS') { volume = wash.outlets != null ? wash.outlets : 3; zone = 'Санузел'; }
    else if (rule === 'BATH_SWITCHES') { volume = wash.switches != null ? wash.switches : 1; zone = 'Санузел'; }
    else if (rule === 'BATH_LIGHTS') { volume = wash.lights != null ? wash.lights : 3; zone = 'Санузел'; }
    else if (rule === 'MATRIX') { volume = volCoeff(pr, code, planning); if (volume == null) { volume = 1; approx = true; } zone = 'Санузел'; }
    let price = w.price;
    if (code === 'EL-001') {
      // EL-001 (электроразводка) — цена зависит от планировки (формула Excel)
      const pp = String(planning || '').toLowerCase();
      if (pp.startsWith('ст')) price = 2538.43;
      else if (pp.startsWith('1')) price = 2790.48;
      else if (pp.startsWith('2') || pp.startsWith('3')) price = 2080.44;
    }
    if (w.volumeOverride != null) { volume = w.volumeOverride; approx = true; }
    if (volume == null) volume = 0;
    const volFull = volume;          // точный объём (как в Excel — без округления для расчёта)
    // Отображение объёма ровно как Excel ROUND(x,2): компенсируем ошибку двоичной арифметики (3.15*43.3=136.39499.. -> 136,40)
    volume = Math.round((volFull * 100 + 1e-7)) / 100;
    const costExact = (price != null) ? volFull * price : null;   // точная себестоимость строки (для ценообразования)
    const cost = (costExact != null) ? Math.round(costExact * 100) / 100 : null; // отображаемая
    return { no: i + 1, code, name: w.name, zone, unit, material, volume, price, cost, costExact, approx };
  });

  let totalCost, totalCostExact;
  if (hasPrices) {
    totalCostExact = rows.reduce((s, r) => s + (r.costExact || 0), 0);  // неокруглённая сумма (как Excel I48)
    totalCost = Math.round(totalCostExact * 100) / 100;                 // отображение — округление в конце
  } else {
    totalCost = Math.round((data.projects_price_m2[project] || 28500) * S);
    totalCostExact = totalCost;
  }

  // --- Ценообразование по формуле Excel (Расчёт + Справочник) ---
  const klass = (pr.class) || (data.spravochnik && data.spravochnik._проекты && data.spravochnik._проекты[project]) || 'Комфорт';
  // «срок до ввода + 3 мес, дни»: считаем от даты договора до даты ввода + 90 дней (как DATEDIF в Excel)
  let days = pr.days != null ? pr.days : 0;
  if (pr.ввод) {
    const from = dateStr || new Date(Date.now() - (new Date().getTimezoneOffset()*60000)).toISOString().slice(0,10);
    const t0 = Date.parse(from), t1 = Date.parse(pr.ввод);
    if (!isNaN(t0) && !isNaN(t1)) {
      const d = Math.max(0, Math.round((t1 - t0) / 86400000));
      days = d + 90;
    }
  }
  // --- Ценообразование строго по формуле Excel (лист «Расчет» + «Справочник») ---
  // Порядок (ДДУ/ДКП): себестоимость/м² + инфляция × дни/365 → × коэф. площади → × коэф. класса → × (1+маржа) → + налог на прибыль.
  const INFL = (data.pricing && data.pricing.инфляция) || (currentSprav().инфляция != null ? currentSprav().инфляция : 0.10);
  const NALOG = (data.pricing && data.pricing.налог) || (currentSprav().налогПрибыль != null ? currentSprav().налогПрибыль : 0.25);
  const isDdu = /ДДУ|ДКП/.test(scenario || '');            // ДДУ и ДКП — один путь
  const CLASS = { 'Эконом':[0.80,0.90], 'Комфорт':[1,1], 'Комфорт+':[1.10,1.12], 'Бизнес':[1.18,1.25] };
  const ci = isDdu ? 0 : 1;                                 // 0=ДДУ, 1=подряд
  const marginSet = isDdu ? (currentSprav().маржаДду != null ? currentSprav().маржаДду : 0.18)
                          : (currentSprav().маржаПодряд != null ? currentSprav().маржаПодряд : 0.25);
  const classCoef = (CLASS[klass] ? CLASS[klass][ci] : 1);
  let areaCoef;
  if (isDdu) areaCoef = S <= 35 ? 1 : (S <= 55 ? 0.97 : 0.94);
  else areaCoef = S <= 35 ? 1.08 : (S <= 55 ? 1.04 : 1.00);
  const cost_m2 = S > 0 ? totalCostExact / S : 0;   // из НЕокруглённой суммы (как Excel J48 = I48/D2)
  // B: база с инфляцией = себестоимость/м² × (1 + инфляция ÷ 365 × дней)
  const baseE = cost_m2 + cost_m2 * (INFL / 365) * days;
  // B14/B26: расчётная цена до налога = база × коэф.площади × коэф.класса × (1 + маржа)
  const preTax = baseE * areaCoef * classCoef * (1 + marginSet);
  // B15/B27: цена с налогом на прибыль = preTax + (preTax − база) × налог
  const priceM2 = preTax + (preTax - baseE) * NALOG;
  // Итоговая цена, руб./м² = priceM2 (в Excel B17 = B15, B29 = B27 — без рыночного потолка)
  // Стоимость пакета = итоговая цена/м² × S
  const sale = Math.round(priceM2 * S * 100) / 100;
  // Множитель пакета для построчной «Стоимости» (как Excel: стоимость строки = себестоимость строки × тот же коэфф.)
  const Ktot = cost_m2 > 0 ? priceM2 / cost_m2 : 1;
  const per_m2 = S > 0 ? sale / S : 0;
  const margin = totalCost > 0 ? (sale - totalCost) / totalCost : 0;
  return { rows, totalCost, sale, per_m2, cost_m2, margin, S, hasPrices, klass, days,
    K: { Ktot, priceM2, preTax, base: cost_m2, area: areaCoef, class: classCoef, marginSet, INFL, NALOG, path: isDdu ? 'ДДУ/ДКП' : 'Договор подряда',
         k1: 1, k2: areaCoef, k3: 1, k4: 1, kTotal: Ktot } };
}

// ---------- HTML ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// --- вкладка «Расчёт» ---
function calcTab(result, q, data) {
  let h = `<div class="card" id="tab-расчёт"><h2>Расчёт — ${esc(q.vid)}</h2>`;
  if (!result) {
    h += `<div class="hint">Выберите параметры на вкладке «Калькулятор» — здесь появится расчёт по обеим схемам продажи.</div>`;
    return h + `</div>`;
  }
  const SPR = currentSprav();
  const S = result.S;
  const klass = result.klass;
  const days = result.days;
  const predch = /предчистовая/i.test(q.vid);
  const рынок = predch ? SPR.предчистоваяРынок : (SPR.рынок[klass] || 28500);

  // Вычисляем обе схемы тем же движком, что и «Калькулятор» (compute)
  const rDdu = compute(data, q.project, q.planning, q.vid, 'ДДУ/ДКП', q.srok, q.rent, q.date);
  const rPod = compute(data, q.project, q.planning, q.vid, 'Договор подряда', q.srok, q.rent, q.date);

  // Функция построения блока одной схемы (Excel-структура «Расчёт»)
  const schemeBlock = (label, rr, opts) => {
    if (!rr) return `<h3 class="sub">${esc(label)}</h3><div class="hint">Нет данных.</div>`;
    const K = rr.K;
    const base = K.base, preTax = K.preTax, priceM2 = K.priceM2;
    // Итоговая цена = расчётная цена с налогом (в Excel B17 = B15, B29 = B27), без рыночного потолка в итоге
    const итог = priceM2;
    const sale = rr.sale;
    const ниже = (итог < rr.cost_m2 - 1e-9) ? 'ДА' : 'НЕТ';
    const row = (p, v) => `<tr><td>${p}</td><td class="num">${v}</td></tr>`;
    const pct = (v) => (Math.round(v*100)) + '%';
    const rows = `
      ${row('Инфляция', pct(K.INFL))}
      ${row('Коэффициент площади', rub2(K.area))}
      ${row('Коэффициент класса', rub2(K.class))}
      ${row('Расчетная цена до налога прибыль, руб./м²', rub2(preTax))}
      ${row('Расчетная цена с налогом на прибыль, руб./м²', rub2(priceM2))}
      ${row(opts.marketLabel, rub2(рынок))}
      ${row('Итоговая цена, руб./м²', rub2(итог))}
      ${row(opts.costLabel, rub(opts.costTotal? sale : sale))}
      ${row('Минимальная цена подряда (себестоимость), руб./м²', rub2(rr.cost_m2))}
      ${row('Цена подряда ниже минимальной?', ниже)}`;
    return `<h3 class="sub">${esc(label)}</h3><table class="summary cc"><colgroup><col class="c1"><col class="c2"></colgroup><tbody>${rows}</tbody></table>`;
  };

  // Шапка (как в Excel «Расчет»)
  h += `
  <table class="summary cc"><colgroup><col class="c1"><col class="c2"></colgroup><tbody>
    <tr><td>Вид отделки</td><td>${esc(q.vid)}</td></tr>
    <tr><td>Площадь квартиры, м²</td><td class="num">${rub2(S)}</td></tr>
    <tr><td>Проект</td><td>${esc(q.project)}</td></tr>
    <tr><td>Класс жилья</td><td>${esc(klass)}</td></tr>
    <tr><td>Себестоимость, руб./м²</td><td class="num">${rub2(result.cost_m2)}</td></tr>
    <tr><td>Дата заключения договора</td><td>${esc(q.date || '—')}</td></tr>
    <tr><td>Срок до ввода + 3 мес, дни</td><td class="num">${rub2(days)}</td></tr>
    <tr><td>Рыночная цена, руб./м²</td><td class="num">${rub2(рынок)}</td></tr>
  </tbody></table>`;

  h += schemeBlock('РАСЧЕТ ДДУ/ДКП', rDdu, { marketLabel: 'Рыночный потолок с учетом коэффициента площади и класса, руб./м²', costLabel: 'Стоимость ремонта, руб.' });
  h += schemeBlock('РАСЧЕТ ОТДЕЛЬНОГО ДОГОВОРА ПОДРЯДА', rPod, { marketLabel: 'Рыночная цена, руб./м²', costLabel: 'Стоимость отдельного подряда, руб.' });
  h += `${rDdu && rPod ? `
  <h3 class="sub">Стоимость по схемам продажи</h3>
  <table class="summary costcmp"><thead><tr><th></th><th>Стоимость, ₽</th><th>Стоимость, ₽/м²</th></tr></thead><tbody>
    <tr><td>ДДУ/ДКП</td><td class="num">${rub(rDdu.sale)}</td><td class="num">${rub(rDdu.K.priceM2)}</td></tr>
    <tr><td>Договор подряда</td><td class="num">${rub(rPod.sale)}</td><td class="num">${rub(rPod.K.priceM2)}</td></tr>
  </tbody></table>` : ''}`;

  return h + `</div>`;
}

// --- вкладка «Матрица К» (роль 6): коэффициенты ценообразования К1..К4 ---
// Полный аналог листа «Матрица К» книги Excel, редактируется ролью 6.
function matrixKTab(role) {
  const MK = currentMatrixK();
  const k1 = MK.k1 || {};
  const k2 = Array.isArray(MK.k2) ? MK.k2 : [];
  const k3 = Array.isArray(MK.k3) ? MK.k3 : [];
  const k4 = MK.k4 || {};
  const K1_KEYS = ['ДДУ','ДКП','Договор подряда'];
  // поле для числа: путь data-kk (храним как число от 0.001)
  const num = (path, val) => `<input class="ed num kk-num" data-kpath="${esc(path)}" type="number" step="0.001" value="${val != null ? val : ''}">`;
  // К1 — сценарий продажи (3 строки)
  const k1Rows = K1_KEYS.map(k => `
    <tr><td>${esc(k)}</td><td class="num">${num('k1.'+k, k1[k])}</td>
      <td class="cmt">${k==='ДДУ'?'Отделка включена в сделку / ипотеку':k==='ДКП'?'Отдельная продажа отделки':'Рыночный договор на отделочные работы'}</td></tr>`).join('');
  // К2 — площадь квартиры (та же шкала, что и в Excel: <35 / 35–50 / 50–70 / 70–90 / >90)
  const K2_LBL = ['< 35 м²','35–50 м²','50–70 м²','70–90 м²','> 90 м²'];
  const k2Rows = k2.map((r,i) => `
    <tr><td>${esc(K2_LBL[i] || r.label)}</td><td class="num">${num('k2.'+i+'.k', r.k)}</td>
      <td class="cmt">Коэффициент по площади квартиры</td></tr>`).join('');
  // К3 — срок реализации (0 лет / 1 год / 2 года)
  const K3_LBL = ['0 лет','1 год','2 года'];
  const k3Rows = k3.map((r,i) => `
    <tr><td>${esc(K3_LBL[i] || r.label)}</td><td class="num">${num('k3.'+i+'.k', r.k)}</td>
      <td class="cmt">${i===0?'Сдача в этом году':i===1?'Сдача через 1 год':'Сдача через 2 года'}</td></tr>`).join('');
  // К4 — рентабельность (Да / Нет)
  const k4Rows = [['Да','Плановая рентабельность достигнута'],['Нет','Нужна надбавка']].map(([k,cmt]) => `
    <tr><td>${esc(k)}</td><td class="num">${num('k4.'+k, k4[k])}</td><td class="cmt">${esc(cmt)}</td></tr>`).join('');
  const h = `
  <div class="card" id="tab-матрица-к">
    <h2>Матрица К — коэффициенты ценообразования</h2>
    <div class="hint">✏️ Вы администратор матриц (роль 6): коэффициенты ниже можно редактировать. К общий = К1 × К2 × К3 × К4; цена продажи = себестоимость × К общий. Правки сохраняются на сервере и видны всем.</div>
    <table class="summary sprav"><thead><tr><th>Параметр</th><th>Значение</th><th>Комментарий</th></tr></thead><tbody>
      <tr class="sec"><td colspan="3">К1 — сценарий продажи</td></tr>
      ${k1Rows}
      <tr class="sec"><td colspan="3">К2 — площадь квартиры</td></tr>
      ${k2Rows}
      <tr class="sec"><td colspan="3">К3 — срок реализации</td></tr>
      ${k3Rows}
      <tr class="sec"><td colspan="3">К4 — рентабельность проекта</td></tr>
      ${k4Rows}
    </tbody></table>
    <div class="row"><button class="btn" onclick="saveMatrixK()">💾 Сохранить матрицу К</button><span class="hint" id="matrixk-status"></span></div>
    <div class="hint">Цена продажи = Себестоимость × К общий (К общий = К1 × К2 × К3 × К4). Для основных работ дополнительно действует рыночный ограничитель.</div>
  </div>`;
  return h;
}

// --- вкладка «Справочник» ---
function spravTab(role) {
  const SPR = currentSprav();
  const canEdit = !!(role && role.editCost); // роль 4 — стоимость работы/пакета
  const f = (v) => v != null ? (Math.round(v*100)/100) : '—';
  const sc = (path, val, step) => canEdit
    ? `<input class="ed num s-num" data-path="${esc(path)}" type="number" step="${step}" value="${val}">`
    : f(val);
  // процентный ввод: храним долю (0.25), показываем/правим как 25%
  const scPct = (path, val) => canEdit
    ? `<input class="ed num s-num s-pct" data-path="${esc(path)}" data-pct="1" type="number" step="1" value="${Math.round((val||0)*100)}">`
    : (Math.round((val||0)*100)) + '%';
  const kMap = (path, obj) => Object.entries(obj).map(([k,v]) =>
    `<tr><td>${esc(k)}</td><td class="num">${sc(path+'.'+k, v, '0.001')}</td></tr>`).join('');
  const kArr = (path, arr) => ['До 35 м²','35–55 м²','55–80 м²'].map((lbl,i) =>
    `<tr><td>${lbl}</td><td class="num">${sc(path+'.'+i+'.1', arr[i][1], '0.001')}</td></tr>`).join('');
  const noticedit = canEdit ? '<div class="hint">✏️ Вы администратор стоимостей: значения ниже можно редактировать (роль 4). Правки сохраняются на сервере и видны всем.</div>' : '';
  const savebtn = canEdit ? `<div class="row"><button class="btn" onclick="saveSprav()">💾 Сохранить справочник</button><span class="hint" id="sprav-status"></span></div>` : '';
  // единая трёхколоночная таблица: Параметр | Значение | Комментарий
  const row3 = (p, v, c) => `<tr><td>${p}</td><td class="num">${v}</td><td class="cmt">${c}</td></tr>`;
  const sec3 = (t) => `<tr class="sec"><td colspan="3">${esc(t)}</td></tr>`;
  const kMap3 = (path, obj, cmt) => Object.entries(obj).map(([k,v]) =>
    row3(esc(k), sc(path+'.'+k, v, '0.001'), cmt)).join('');
  const kArr3 = (path, arr, labels, cmt) => labels.map((lbl,i) =>
    row3(lbl, sc(path+'.'+i+'.1', arr[i][1], '0.001'), cmt)).join('');

  // таблица проектов (ввод объектов): дни считаем от даты договора до ввода + 3 мес (90 дней)
  const now = new Date(Date.now() - new Date().getTimezoneOffset()*60000);
  const todayStr = now.toISOString().slice(0,10).split('-').reverse().join('.');
  const dms = s => { const [d,m,y]=s.split('.'); return new Date(+y,+m-1,+d).getTime(); };
  const daysIn = (inp) => inp ? (Math.round((dms(inp) - dms(todayStr))/86400000) + 90) : 0;
  const projects = [
    ['Семейный','Комфорт',''],
    ['Scandi','Комфорт',''],
    ['RED/SKY','Комфорт',''],
    ['Оливия','Комфорт+','30.11.2026'],
    ['Tetris','Эконом','31.05.2027'],
    ['Okland','Комфорт','31.08.2027'],
    ['ДУО','Комфорт','30.04.2028'],
    ['Бабефа','Бизнес','30.06.2028'],
    ['Федерация','Бизнес','30.09.2028'],
    ['КОСМО','Комфорт','30.09.2028']
  ];
  const projRows = projects.map(([p,kl,inp]) =>
    `<tr><td>${esc(p)}</td><td>${esc(kl)}</td><td class="num">${inp || '—'}</td><td class="num">${inp ? todayStr : '—'}</td><td class="num">${daysIn(inp)}</td></tr>`).join('');

  const h = `
  <div class="card" id="tab-справочник"><h2>Справочник</h2>
    ${noticedit}
    <table class="summary sprav"><thead><tr><th>Параметр</th><th>Значение</th><th>Комментарий</th></tr></thead><tbody>
      ${sec3('Общие параметры')}
      ${row3('Налог на прибыль', scPct('налогПрибыль', SPR.налогПрибыль), 'Ставка налога на прибыль')}
      ${row3('Инфляция годовая', scPct('инфляция', SPR.инфляция), 'Годовой индекс инфляции')}
      ${row3('Маржинальность ДДУ/ДКП', sc('маржаДду', SPR.маржаДду, '0.001'), 'Целевая маржинальность по сценарию ДДУ/ДКП')}
      ${row3('Маржинальность (договор подряда)', sc('маржаПодряд', SPR.маржаПодряд, '0.001'), 'Целевая маржинальность по «Договору подряда»')}

      ${sec3('Коэффициенты класса — ДДУ/ДКП')}
      ${kMap3('классДду', SPR.классДду, 'Множитель цены по классу (ДДУ/ДКП)')}

      ${sec3('Коэффициенты класса — договор подряда')}
      ${kMap3('классПодряд', SPR.классПодряд, 'Множитель цены по классу (договор подряда)')}

      ${sec3('Коэффициенты площади — ДДУ/ДКП')}
      ${kArr3('площДду', SPR.площДду, ['До 35 м²','35–55 м²','55–80 м²'], 'Коэффициент площади (ДДУ/ДКП)')}

      ${sec3('Коэффициенты площади — договор подряда')}
      ${kArr3('площПодряд', SPR.площПодряд, ['До 35 м²','35–55 м²','55–80 м²'], 'Коэффициент площади (договор подряда)')}

      ${sec3('Рыночная стоимость ремонта, ₽/м²')}
      ${kMap3('рынок', SPR.рынок, 'Рыночная цена ремонта для класса, ₽/м²')}
      ${row3('Для любого класса жилья (предчистовая)', sc('предчистоваяРынок', SPR.предчистоваяРынок, '0.01'), 'Предчистовая отделка, ₽/м²')}

      ${sec3('Проекты → класс жилья')}
      ${Object.entries(SPR.проекты).map(([k,v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td><td class="cmt"></td></tr>`).join('')}
    </tbody></table>

    <h3 class="sub">Проекты: ввод объектов</h3>
    <table class="summary proj"><thead><tr>
      <th>Проект</th><th>Класс жилья</th><th>Дата ввода</th><th>Дата договора</th><th>Дней до ввода + 3 мес.</th>
    </tr></thead><tbody>
      ${projRows}
    </tbody></table>
    ${savebtn}
  </div>`;
  return h;
}

// --- вкладка «Калькулятор» ---
// Блок «СТОИМОСТЬ КВАРТИРЫ» для роли 7 (учредители). Значения жёстко из книги
// (лист «Калькулятор», строки 5–6) — по решению владельца фиксируются в коде.
// Виден только роли 7 (role.founder).
// Блок «СТОИМОСТЬ КВАРТИРЫ» для роли 7 (учредители). Две строки данных:
//  строка 1 — «Стоимость продажи квартиры по договору, ₽» [ввод] +
//             «Цена квартиры по договору без отделки, ₽/1 кв м» [вычисл.];
//  строка 2 — «Сумма первоначального взноса» [ввод, красный] + пустой блок.
// «Цена без отделки ₽/м²» = (продажа − отделка всего − взнос) / S_ap.
// Вводные значения живут в founder.json (роль 7), отделка всего и S_ap — из калькулятора.
function founderBlockHtml(data, q, result) {
  const p = (data.projects[q.project] && data.projects[q.project].params)
    ? data.projects[q.project].params[q.planning] : null;
  const S = p ? p.S_ap : (result ? result.S : null);
  const finTotal = result ? result.sale : null;   // Стоимость работы/пакета отделки, ₽ (всего)
  const sale = (FOUNDER_V.sale == null) ? '' : FOUNDER_V.sale;
  const down = (FOUNDER_V.down == null) ? '' : FOUNDER_V.down;
  let perM2 = null;
  if (sale !== '' && finTotal != null && down !== '' && S) {
    perM2 = (Number(sale) - Number(finTotal) - Number(down)) / Number(S);
  }
  const fmt = v => (v == null || Number.isNaN(v)) ? '—' : rub2(v);
  return `<div id="founder-block" class="founder" data-f-fin="${finTotal != null ? finTotal : ''}" data-f-s="${S != null ? S : ''}">
  <div id="founder-row-1" class="f-row r1">
    <div id="founder-title" class="f-cell title">СТОИМОСТЬ КВАРТИРЫ</div>
    <div id="founder-lab-sale" class="f-cell lab">Стоимость продажи квартиры по договору, ₽</div>
    <div id="founder-inp-sale" class="f-cell inp"><input type="number" step="0.01" data-f="sale" value="${esc(sale)}" oninput="founderRecompute();founderAutoSave()"></div>
    <div id="founder-lab-perm2" class="f-cell lab">Цена квартиры по договору без отделки, ₽/1 кв м</div>
    <div id="founder-out-perm2" class="f-cell out" data-f-out="perM2">${fmt(perM2)}</div>
  </div>
  <div id="founder-row-2" class="f-row r2">
    <div id="founder-lab-down" class="f-cell lab span2">Сумма первоначального взноса</div>
    <div id="founder-inp-down" class="f-cell inp"><input type="number" step="0.01" data-f="down" value="${esc(down)}" oninput="founderRecompute();founderAutoSave()" class="f-red-in"></div>
    <div id="founder-empty" class="f-cell empty span2"></div>
  </div>
</div>`;
}
function roomsFromPlan(plan) {
  const m = String(plan || '').match(/^(\d)/);
  return m ? +m[1] : '';
}
function calcFormHtml(role, data, q, result, flash) {
  const admin = role.admin;
  const projects = Object.keys(data.projects);
  const plannings = data.projects[q.project] ? Object.keys(data.projects[q.project].params) : [];
  const vids = Object.keys(data.compositions);
  const sel = (v, arr) => (arr.includes(v) ? 'selected' : '');
  const opt = (arr, v) => arr.map(x => `<option value="${esc(x)}" ${sel(x, [v])}>${esc(x)}</option>`).join('');
  const vidTitle = (q.vid || vids[0] || 'ОТДЕЛКА').toUpperCase();
  const p = data.projects[q.project] ? data.projects[q.project].params[q.planning] : null;
  const S = p ? p.S_ap : (result ? result.S : null);
  const S_useful = p ? p.S_useful : null;
  const roomsVal = (p && p.rooms != null) ? p.rooms : roomsFromPlan(q.planning);
  const Ktot = result ? result.K.Ktot : 1;

  // параметры шапки — таблица, чтобы элементы выравнивались без «лесенки»
  const pcell = (lbl, ctl, cls = '') => `<td class="param ${cls}"><div class="p-in"><span class="p-lbl">${lbl}</span><span class="p-ctl">${ctl}</span></div></td>`;
  const pval = (lbl, v, cls = '') => pcell(lbl, `<span class="val">${v}</span>`, cls);
  const vlab = (lbl, cls = '') => `<td class="param v ${cls}"><div class="p-in"><span class="p-lbl">${lbl}</span></div></td>`;
  const vctl = (ctl) => `<td class="param v"><div class="p-in"><span class="p-ctl">${ctl}</span></div></td>`;
  const vidSel = (cur) => `
<span class="vid-dd">
  <button type="button" class="vid-btn" onclick="vidToggle(event)">
    <span class="vid-lbl" id="vidLbl">${esc(cur)}</span>
    <span class="vid-caret">▾</span>
  </button>
  <div class="vid-list" id="vidList">
    ${vids.map(v => `<div class="vid-opt${v === cur ? ' on' : ''}" onclick="vidPick('${esc(v)}')">${esc(v)}</div>`).join('')}
  </div>
  <select name="vid" id="vidSel" class="vid-sel" onchange="recalc()">${opt(vids, cur)}</select>
</span>`;

  const paramsTable = `<table class="params-tbl"><tbody>
    <tr>
      ${pcell('Проект', `<select name="project" onchange="recalc()">${opt(projects, q.project)}</select>`)}
      ${pval('S квартиры, м²', S != null ? rub2(S) : '—')}
      ${pval('Полезная S, м²', S_useful != null ? rub2(S_useful) : '—')}
      ${vlab('Дата<br>заключения<br>договора', 'date-lab')}
      ${vlab('Вид договора', 'vid-lab')}
    </tr>
    <tr>
      ${pcell('Планировка', `<select name="planning" onchange="recalc()">${opt(plannings, q.planning)}</select>`)}
      ${pcell('ВИД ОТДЕЛКИ', vidSel(q.vid))}
      ${pcell('Комнат', `<span class="val rooms-lock" title="Автоматически по планировке">${roomsVal != null ? roomsVal : '—'}</span>`)}
      ${vctl(`<input type="date" name="date" value="${esc(q.date || '')}" onchange="recalc()">`)}
      ${vctl(`<select name="scenario" onchange="recalc()">${opt(['ДДУ/ДКП', 'Договор подряда'], q.scenario)}</select>`)}
    </tr>
  </tbody></table>`;

  // стоимость — отдельная соседняя таблица
  const costTable = `<table class="cost-tbl"><colgroup><col style="width:20%"><col style="width:26%"><col style="width:28%"><col style="width:26%"></colgroup><tbody><tr>
      <td class="c-lbl">Стоимость пакета<br>отделки, ₽</td><td class="c-val">${result ? rub0(result.sale) : '—'}</td>
      <td class="c-lbl">Стоимость пакета<br>отделки, ₽/1 кв м</td><td class="c-val">${result ? rub0(result.per_m2) : '—'}</td>
    </tr></tbody></table>`;

  const detailFullTable = (res, role, qq, ktot) => {
    const th = ['№', 'Код', 'Работы', 'Помещение/зона', 'Материал', 'Ед. изм.', 'Объем работ',
      'Себестоимость<br>работа+материал<br>+налоги, ₽/ед.<br>изм.',
      'Общая себестоимость<br>работы/пакета<br>отделки, ₽',
      'Себестоимость<br>работы/пакета<br>отделки, ₽/1 кв м',
      'Стоимость<br>работы/пакета<br>отделки, ₽',
      'Стоимость<br>работы/пакета<br>отделки, ₽/1 кв м'];
    const colw = [34,52,180,130,128,66,80,118,128,100,118,100];
    let h = `<div class="tblwrap detailw"><table class="detail xls-table" style="table-layout:fixed;width:100%"><colgroup>${colw.map(w=>`<col style="width:${w}px">`).join('')}</colgroup><thead><tr>${th.map(t => `<th>${t}</th>`).join('')}</tr></thead><tbody>`;
    const Ss = res.S;
    for (const r of res.rows) {
      const nm = r.approx ? `<span title="Рассчитано по правилу Excel (приближение)" class="bp">${esc(r.name)} ⚠</span>` : esc(r.name);
      const ss = (r.cost != null && Ss > 0) ? r.cost / Ss : null;   // себестоимость ₽/м²
      const sk = r.costExact != null ? r.costExact * ktot : null;   // стоимость пакета ₽ (из точной себестоимости строки, как Excel K50)
      const skm = (sk != null && Ss > 0) ? sk / Ss : null;          // стоимость ₽/м²
      h += `<tr>
        <td class="c">${r.no}</td><td>${esc(r.code)}</td>
        <td class="l">${nm}</td>
        <td>${esc(r.zone)}</td><td class="mat">${esc(r.material)}</td><td class="c">${esc(r.unit)}</td>
        <td class="num">${r.volume}</td>
        <td class="num">${role.editMaterials ? `<input class="ed num" data-kind="price" data-no="${r.no}" type="number" step="0.1" value="${r.price != null ? r.price : ''}" placeholder="—">` : (r.price != null ? r.price : '—')}</td>
        <td class="num">${r.cost != null ? rub(r.cost) : '—'}</td>
        <td class="num">${ss != null ? rub2(ss) : '—'}</td>
        <td class="num">${sk != null ? rub(sk) : '—'}</td>
        <td class="num">${skm != null ? rub2(skm) : '—'}</td></tr>`;
    }
    h += `<tr class="tot">
      <td></td><td colspan="2">ИТОГО</td><td></td><td></td><td></td><td></td><td></td>
      <td class="num">${rub(res.totalCost)}</td>
      <td class="num">${rub2(res.cost_m2)}</td>
      <td class="num">${rub(res.sale)}</td>
      <td class="num">${rub2(res.per_m2)}</td></tr>`;
    h += '</tbody></table></div>';
    if (!res.hasPrices) {
      h += `<div class="hint">Цены за единицу для «${esc(qq.vid)}» не заданы — себестоимость пакета рассчитана по Справочнику (рыночная стоимость ремонта, ₽/м²).</div>`;
    }
    if (role.editMaterials) {
      h += `<div class="row"><button class="btn" onclick="saveEdits('${esc(qq.vid)}')">💾 Сохранить правки</button>
        <span class="hint" id="save-status"></span></div>
      <div class="hint">Вы администратор себестоимости: изменяется только колонка «Себестоимость работа+материал+налоги, ₽/ед. изм.». Наименование работ и объём не редактируются.</div>`;
    }
    return h;
  };

  let body = `
  <form method="get" class="card xls" id="calc">
    <div class="xls-title">${esc(vidTitle)}</div>
    <div class="xls-head">
      <div class="xlscard left"><div class="xls-grid">${paramsTable}</div></div>
      <div class="xlscard right"><div class="xls-grid">${costTable}</div></div>
    </div>
    ${role.finance8 ? finance8.block(q, result) : role.founder ? founderBlockHtml(data, q, result) : ''}
    ${role.canViewDetail ? `
    <div class="xls-sec">СОСТАВ ПАКЕТА ОТДЕЛКИ</div>
    ${result ? detailFullTable(result, role, q, Ktot) : `<div class="hint">Выберите параметры для расчёта.</div>`}
    ` : ''}
  </form>`;
  if (flash) body += `<div class="flash">${esc(flash)}</div>`;
  return `<div id="tab-калькулятор">${body}</div>`;
}

// Дамп результата «как в Excel» (TSV с табуляцией) для роли 5 (debug) — для сверки с исходником.
function buildDump(result, q, Ktot) {
  const S = result ? result.S : 0;
  const rows = result ? result.rows : [];
  const lines = [];
  lines.push(['Параметры расчёта', 'Проект: ' + q.project, 'Планировка: ' + q.planning,
    'Вид отделки: ' + q.vid, 'Сценарий: ' + q.scenario].join('\t'));
  lines.push((['Площадь квартиры, м²', S ? rub2(S) : '']).join('\t'));
  lines.push(['№','Код','Работы','Помещение/зона','Материал','Ед.изм.','Объем работ',
    'Себестоимость ₽/ед.изм.','Общая себестоимость ₽','Себестоимость ₽/м²',
    'Стоимость пакета ₽','Стоимость ₽/м²'].join('\t'));
  for (const r of rows) {
    const ss = (r.cost != null && S > 0) ? r.cost / S : null;
    const sk = r.costExact != null ? r.costExact * Ktot : null;   // из точной себестоимости строки (как Excel K50)
    const skm = (sk != null && S > 0) ? sk / S : null;
    lines.push([
      r.no, r.code, r.name || '', r.zone || '', r.material || '', r.unit || '',
      r.volume != null ? rub2(r.volume) : '',
      r.price != null ? rub(r.price) : '',
      r.cost != null ? rub(r.cost) : '',
      ss != null ? rub2(ss) : '',
      sk != null ? rub(sk) : '',
      skm != null ? rub2(skm) : ''
    ].join('\t'));
  }
  if (result) {
    lines.push(['','','ИТОГО','','','','','',
      rub(result.totalCost), rub2(result.cost_m2), rub(result.sale), rub2(result.per_m2)].join('\t'));
  }
  return lines.join('\n');
}

// --- вкладка «ИТОГ» (роль 5 debug) — сокращённая калькуляция по всем комбинациям ---
function itogRows(data, dateStr) {
  const out = [];
  const scenarios = ['ДДУ/ДКП', 'Договор подряда'];
  for (const proj of Object.keys(data.projects)) {
    for (const plan of Object.keys(data.projects[proj].params)) {
      for (const vid of Object.keys(data.compositions)) {
        for (const sc of scenarios) {
          // «0 лет» / «Да (рентабельность)» — нейтральные параметры срока/маржи
          const r = compute(data, proj, plan, vid, sc, '0 лет', 'Да (рентабельность достигнута)', dateStr);
          if (!r) continue;
          out.push({ proj, plan, vid, sc, totalCost: r.totalCost, cost_m2: r.cost_m2, sale: r.sale, per_m2: r.per_m2 });
        }
      }
    }
  }
  return out;
}
function itogTab(data, q, dateStr) {
  const rows = itogRows(data, dateStr);
  const fmt = r => `<tr><td>${esc(r.proj)}</td><td>${esc(r.plan)}</td><td>${esc(r.vid)}</td><td>${esc(r.sc)}</td>
    <td class="num">${rub(r.totalCost)}</td><td class="num">${rub2(r.cost_m2)}</td>
    <td class="num">${rub(r.sale)}</td><td class="num">${rub2(r.per_m2)}</td></tr>`;
  return `<div class="card" id="tab-итог"><h2>ИТОГ — калькуляция по всем проектам (сокращённо)</h2>
    <div class="row itog-bar">
      <button class="btn" id="itogrecalc">🔄 Пересчитать</button>
      <button class="copyred" id="itogcopy" title="Скопировать таблицу ИТОГ как в Excel (для сверки)">📋 Скопировать таблицу</button>
      <span class="hint">Комбинаций: ${rows.length} (проект × планировка × вид отделки × ДДУ/ДКП или договор подряда). Показывается только строка ИТОГО: Общая себестоимость ₽ · Себестоимость ₽/м² · Стоимость ₽ · Стоимость ₽/м².</span>
    </div>
    <div class="tblwrap itogw"><table class="detail itog" id="itog-table"><thead><tr>
      <th>Проект</th><th>Планировка</th><th>Вид отделки</th><th>Сценарий</th>
      <th class="num">Общая себестоимость ₽</th><th class="num">Себестоимость ₽/м²</th>
      <th class="num">Стоимость ₽</th><th class="num">Стоимость ₽/м²</th></tr></thead>
      <tbody data-itog>${rows.map(fmt).join('')}</tbody></table></div>
  </div>`;
}

// --- вкладка «Матрицы» (роль 6): редактирование объёмов работ по проектам,
// параметров и добавление планировок, а также строк работ в составах отделки. ---
function matrixTab(role, data, q) {
  const projects = Object.keys(data.projects);
  const project = data.projects[q.project] ? q.project : (projects[0] || '');
  const pr = data.projects[project] || { params: {}, volumes: {}, wash: {} };
  const plannings = Object.keys(pr.params);
  const plan = plannings.includes(q.planning) ? q.planning : (plannings[0] || '');
  const p = pr.params[plan] || {};
  const wash = (pr.wash && pr.wash[plan]) || {};
  // все коды работ, встречающиеся в любом составе (строки матрицы объёмов)
  const codes = [];
  (() => { const set = new Set(); for (const vid of Object.keys(data.compositions)) for (const r of data.compositions[vid]) if (r.code) set.add(r.code); for (const c of set) codes.push(c); })();
  // поля параметров планировки и комплектации СУ
  const PARAMS = [
    ['S_ap','S квартиры, м²','0.1'],['S_useful','Полезная S, м²','0.1'],['S_SU','S санузла, м²','0.01'],
    ['rooms','Комнат','1'],['S_walls_total','Стены всего, м²','0.01'],['S_walls_noSU','Стены без СУ, м²','0.01'],
    ['S_walls_SU','Стены СУ, м²','0.01'],['perimeter','Периметр, м','0.01'],['plinth','Плинтус, м','0.01']
  ];
  const WASH = [
    ['perim','Периметр СУ, м','0.1'],['doors','Двери СУ, шт','1'],['outlets','Розетки СУ, шт','1'],
    ['switches','Выключатели СУ, шт','1'],['lights','Светильники СУ, шт','1']
  ];
  const RULES = ['FULL','MATRIX','BATH_FLOOR','BATH_WALL','BATH_CEILING','BATH_PERIMETER','BATH_DOORS','BATH_OUTLETS','BATH_SWITCHES','BATH_LIGHTS'];
  const selOpt = (arr, v) => arr.map(x => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const projOpt = selOpt(projects, project);
  const planOpt = selOpt(plannings, plan);

  // --- секция планировок: параметры выбранной планировки + комплектация СУ ---
  const paramInputs = PARAMS.map(([k, lbl, step]) =>
    `<div class="mx-field"><label>${lbl}</label><input class="ed mx-num" data-mx="param" data-plan="${esc(plan)}" data-field="${k}" type="number" step="${step}" value="${p[k] != null ? p[k] : ''}"></div>`).join('');
  const washInputs = WASH.map(([k, lbl, step]) =>
    `<div class="mx-field"><label>${lbl}</label><input class="ed mx-num" data-mx="wash" data-plan="${esc(plan)}" data-field="${k}" type="number" step="${step}" value="${wash[k] != null ? wash[k] : ''}"></div>`).join('');

  // --- матрица объёмов: коды × планировки ---
  const volCells = codes.map(c => {
    const vv = (pr.volumes && pr.volumes[c]) || {};
    const cells = plannings.map(pl => {
      const val = vv[pl] != null ? vv[pl] : '';
      return `<td><input class="ed mx-num mx-vol" data-mx="vol" data-code="${esc(c)}" data-plan="${esc(pl)}" type="number" step="0.001" value="${val}"></td>`;
    }).join('');
    return `<tr><td class="mx-code">${esc(c)}</td>${cells}</tr>`;
  }).join('');
  const volHead = plannings.map(pl => `<th class="mx-plan">${esc(pl)}</th>`).join('');

  // --- строки работ в составе выбранного вида отделки ---
  const vids = Object.keys(data.compositions);
  const vid = vids.includes(q.vid) ? q.vid : (vids[0] || '');
  const comp = data.compositions[vid] || [];
  const compRows = comp.map(r => {
    const no = r.no;
    const price = r.price != null ? r.price : '';
    return `<tr>
      <td class="c">${no}</td>
      <td><input class="ed mx-row" data-vid="${esc(vid)}" data-no="${no}" data-field="code" value="${esc(r.code || '')}" placeholder="код"></td>
      <td><input class="ed mx-row" data-vid="${esc(vid)}" data-no="${no}" data-field="name" value="${esc(r.name || '')}" placeholder="наименование"></td>
      <td><select class="ed mx-row" data-vid="${esc(vid)}" data-no="${no}" data-field="rule">${selOpt(RULES, r.rule)}</select></td>
      <td><input class="ed mx-num mx-row" data-vid="${esc(vid)}" data-no="${no}" data-field="price" data-num="1" type="number" step="0.1" value="${price}"></td>
      <td><input class="ed mx-row" data-vid="${esc(vid)}" data-no="${no}" data-field="comment" value="${esc(r.comment || '')}" placeholder="комментарий"></td>
    </tr>`;
  }).join('') + `<tr class="mx-newrow">
      <td class="c">нов.</td>
      <td><input class="ed mx-newrow" data-vid="${esc(vid)}" data-field="code" placeholder="новый код"></td>
      <td><input class="ed mx-newrow" data-vid="${esc(vid)}" data-field="name" placeholder="наименование"></td>
      <td><select class="ed mx-newrow" data-vid="${esc(vid)}" data-field="rule">${RULES.map(x => `<option>${x}</option>`).join('')}</select></td>
      <td><input class="ed mx-num mx-newrow" data-vid="${esc(vid)}" data-field="price" data-num="1" type="number" step="0.1" placeholder="цена"></td>
      <td><input class="ed mx-newrow" data-vid="${esc(vid)}" data-field="comment" placeholder="комментарий"></td>
    </tr>`;
  const vidSel = selOpt(vids, vid);

  // --- форма добавления новой планировки ---
  const npFields = PARAMS.map(([k, lbl, step]) =>
    `<div class="mx-field"><label>${lbl}</label><input class="ed mx-num mx-np" data-field="${k}" type="number" step="${step}"></div>`).join('');

  return `<div class="card" id="tab-матрицы"><h2>Матрицы — редактирование проекта «${esc(project)}»</h2>
  <div class="hint">✏️ Вы администратор матриц (роль 6). Правки сохраняются на сервере и видны всем. Области: параметры/комплектация СУ выбранной планировки, добавление планировки, матрица объёмов (код × планировка), строки работ в составе отделки.</div>
  <div class="row mx-bar">
    <label>Проект
      <select name="mx-project" onchange="window.location='?tab=матрицы&project='+encodeURIComponent(this.value)">${projOpt}</select>
    </label>
    <button class="btn mx-del" onclick="delProject()" title="Удалить выбранный проект (повлияет на расчёт для всех)">🗑 Удалить</button>
    <label>Планировка
      <select name="mx-planning" onchange="window.location='?tab=матрицы&project=${encodeURIComponent(project)}&planning='+encodeURIComponent(this.value)">${planOpt}</select>
    </label>
    <label class="mx-file">📥 Импорт проекта из файла (.xlsx)
      <input type="file" id="mx-import-file" accept=".xlsx">
    </label>
    <button class="btn mx-import" onclick="importProject()">Загрузить</button>
    <button class="btn mx-save" onclick="saveMatrix()">💾 Сохранить матрицу</button>
    <span class="hint" id="mx-status"></span>
  </div>

  <div id="mx-modal" class="mx-modal" style="display:none">
    <div class="mx-modal-box">
      <div class="mx-modal-title">Удалить проект</div>
      <div class="mx-modal-text" id="mx-modal-text"></div>
      <div class="mx-modal-btns">
        <button class="btn" onclick="closeMxModal()">Отмена</button>
        <button class="btn mx-del" onclick="doDelProject()">🗑 Удалить</button>
      </div>
    </div>
  </div>

  <h3 class="sub">Параметры планировки «${esc(plan)}»</h3>
  <div class="mx-grid">${paramInputs}</div>
  <h3 class="sub">Комплектация санузла «${esc(plan)}»</h3>
  <div class="mx-grid">${washInputs}</div>

  <h3 class="sub">Добавить новую планировку</h3>
  <div class="mx-grid">
    <div class="mx-field"><label>Название планировки</label><input class="ed mx-np-name" placeholder="напр. 3В"></div>
    ${npFields}
  </div>

  <h3 class="sub">Матрица объёмов работ — «${esc(project)}» (коэффициент ${'код'} × планировка)</h3>
  <div class="tblwrap mx-wrap">
    <table class="detail mx-mat"><thead><tr><th class="mx-code">Код</th>${volHead}</tr></thead><tbody>${volCells}</tbody></table>
  </div>

  <h3 class="sub">Строки работ в составе «${esc(vid)}»</h3>
  <label>Вид отделки
    <select name="mx-vid" onchange="window.location='?tab=матрицы&project=${encodeURIComponent(project)}&planning=${encodeURIComponent(plan)}&vid='+encodeURIComponent(this.value)">${vidSel}</select>
  </label>
  <div class="tblwrap mx-wrap">
    <table class="detail mx-comp"><thead><tr><th class="c">№</th><th>Код</th><th>Наименование работ</th><th>Правило</th><th>Цена, ₽/ед.</th><th>Комментарий</th></tr></thead><tbody>${compRows}</tbody></table>
  </div>
  <div class="row"><button class="btn" onclick="saveMatrix()">💾 Сохранить матрицу</button><span class="hint">«нов.» — добавить новую строку работы в состав «${esc(vid)}».</span></div>
  <div class="foot">Роль 6 — администрирование матриц. Изменения влияют на расчёт «Калькулятора» для всех пользователей.</div>
  </div>`;
}

function page(uid, role, data, q, result, flash, tab) {
  // Матрица доступа по вкладкам:
  // роли 1, 2, 3 — «Калькулятор»; роль 4 — «Расчёт», «Справочник» и «Калькулятор» (просмотр).
  const capsS = new Set(role.caps);
  const canCalc = capsS.has('1') || capsS.has('2') || capsS.has('3') || capsS.has('4') || capsS.has('5') || capsS.has('6') || capsS.has('7') || role.finance8;
  const canMisc = capsS.has('4');
  const tabIds = [];
  if (canCalc) tabIds.push('калькулятор');
  if (canMisc || role.finance8) tabIds.push('расчёт');
  if (canMisc) tabIds.push('справочник');
  if (role.editMatrix) tabIds.push('матрицы'); // роль 6 — администрирование матриц
  if (role.editMatrix) tabIds.push('матрица-к'); // роль 6 — матрица коэффициентов ценообразования К1..К4
  if (role.debug) tabIds.push('итог'); // роль 5 (debug) — сводная калькуляция по всем проектам
  const cur = tabIds.includes(tab) ? tab : (tabIds[0] || 'калькулятор');
  const tabBtn = (id, label) =>
    `<button class="tb ${id===cur?'on':''}" data-tab="${id}">${label}</button>`;
  const ctx = role.debug ? '' : 'oncontextmenu="return false"';
  const dumpStr = role.debug && result ? buildDump(result, q, result.K.Ktot) : '';
  const dateStr = q.date || (new Date(Date.now() - (new Date().getTimezoneOffset()*60000)).toISOString().slice(0,10));

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">${bitrix.client}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Калькулятор отделки</title>
<style>
${CSS}
#finance8 .f8-label,.cost-tbl .c-lbl{font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700}
#finance8 .f8-value,.cost-tbl .c-val{font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
</style></head><body ${ctx} class="${role.admin?'admin':''}${role.debug?' dbg':''}">
<div class="top"><div class="brand">🧮 Калькулятор отделки</div>${role.debug ? `<button id="copybtn" class="copyred" onclick="copyDump()" title="Скопировать дамп таблицы как в Excel (для сверки)">📋 Скопировать</button>` : ''}</div>
<div class="tabs">
  ${canCalc ? tabBtn('калькулятор','Калькулятор') : ''}
  ${canMisc || role.finance8 ? tabBtn('расчёт','Расчёт') : ''}
  ${canMisc ? tabBtn('справочник','Справочник') : ''}
  ${role.editMatrix ? tabBtn('матрицы','Матрицы') : ''}
  ${role.editMatrix ? tabBtn('матрица-к','Матрица К') : ''}
  ${role.debug ? tabBtn('итог','ИТОГ') : ''}
</div>
${canCalc ? calcFormHtml(role, data, q, result, flash) : ''}
${canMisc ? calcTab(result, q, data).replace('</h2>', '</h2>' + (role.finance8 ? finance8.rates() : '')) : role.finance8 ? '<div class="card" id="tab-расчёт">' + finance8.rates() + '</div>' : ''}
${canMisc ? spravTab(role) : ''}
${role.editMatrix ? matrixTab(role, data, q) : ''}
${role.editMatrix ? matrixKTab(role) : ''}
${role.debug ? itogTab(data, q, dateStr) : ''}
<div class="foot">Внутренний сервис. Доступ ограничен ролевой моделью Bitrix24.</div>
<script>
${JS.replace('__INIT_TAB__', JSON.stringify(cur))
    .replace('__DEBUG__', role.debug ? 'true' : 'false')
    .replace('__DUMP__', JSON.stringify(dumpStr).replace(/<\//g, '<\\/'))}
${role.finance8 ? finance8.client : ''}
</script></body></html>`;
}

const CSS = `
${finance8.css}

:root{
  --brand:#0A5A79;          /* заголовочная плашка Excel */
  --brand-grad:#0E6A8F;
  --headbar:#D8D8D8;        /* шапка таблицы Excel */
  --label:#D8D8D8;          /* подписи параметров */
  --input:#D1E5F4;          /* ячейки ввода (голубые) */
  --striped:#F2F4F7;        /* чередование серых */
  --result:#FFF2C1;         /* итоговая жёлтая ячейка */
  --total:#D6E8F7;          /* строка итогов голубая */
  --sec-blue:#EFF7FC;       /* светлая голубая секция */
  --sec-green:#EFF7EA;      /* светлая зелёная секция */
  --green:#5F846B;          /* акцент зелёный */
  --bg:#F1F4F7;             /* фон листа */
  --card:#FFFFFF;
  --ln:#C9D3E8;
  --tx:#191919;             /* основной текст Excel */
  --txblue:#0F3372;         /* синий текст Excel */
  --mut:#595959;            /* серый текст */
  --warn:#B38600;
  --tab-on:#0A5A79;
  --tab-off:#C9D3E8;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:14px/1.45 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;
  user-select:none;-webkit-user-select:none;padding:18px}
body.dbg{user-select:text;-webkit-user-select:text}
.copyred{border:0;border-radius:6px;background:#D1382D;color:#fff;font-weight:700;font-size:13px;
  padding:9px 16px;cursor:pointer;box-shadow:0 1px 4px rgba(209,56,45,.4);margin-left:12px}
.copyred:hover{background:#B32E23}
.copyred:active{transform:translateY(1px)}
@media print{body{display:none!important}}
.top{max-width:1640px;margin:0 auto 12px;display:flex;justify-content:space-between;align-items:center;
  background:linear-gradient(90deg,var(--brand),var(--brand-grad));color:#fff;border-radius:10px;
  padding:14px 20px;box-shadow:0 2px 6px rgba(10,90,121,.25)}
.brand{font-weight:700;font-size:19px;letter-spacing:.3px}
.brand .pro{font-size:12px;color:#CDE6F2;font-weight:400;margin-left:10px}
.who{color:#CDE6F2;font-size:13px}
.tabs{max-width:1640px;margin:0 auto 12px;display:flex;gap:6px}
.tb{flex:1;padding:10px 12px;border:1px solid var(--ln);border-radius:8px 8px 0 0;font:inherit;
  font-weight:600;cursor:pointer;background:var(--sec-blue);color:var(--txblue);border-bottom:0}
.tb.on{background:var(--tab-on);color:#fff}
.card{background:var(--card);border:1px solid var(--ln);border-radius:8px;padding:16px 18px;margin:0 auto 14px;max-width:1640px;box-shadow:0 1px 3px rgba(20,30,60,.07)}
#tab-калькулятор,#tab-расчёт,#tab-справочник,#tab-итог,#tab-матрицы{max-width:1640px;margin:0 auto}
#tab-калькулятор{display:block}
#tab-расчёт,#tab-справочник,#tab-итог,#tab-матрицы{display:none}
.card h2{margin:0 0 12px;font-size:16px;color:var(--brand);letter-spacing:.2px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
label{font-size:12px;color:var(--mut);display:flex;flex-direction:column;gap:4px;font-weight:600}
select,input[type=number]{padding:8px 10px;border:1px solid var(--ln);border-radius:6px;font:inherit;background:var(--input);color:var(--tx);font-weight:500}
.btn{margin-top:12px;background:var(--brand);color:#fff;border:0;border-radius:6px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
.btn:hover{background:var(--brand-grad)}
.hint{color:var(--mut);font-size:12px;margin-top:7px}
.flash{background:var(--sec-green);border:1px solid #C4D7C7;color:#2E5B3A;max-width:1640px;margin:0 auto 14px;padding:9px 14px;border-radius:8px}
.summary{border-collapse:collapse;width:100%}
.summary td{padding:7px 9px;border:1px solid var(--ln)}
.summary tr td:first-child{background:var(--label);color:#333;font-weight:600}
.summary .tot td{font-weight:700;font-size:15px}
.summary .tot td:first-child{background:var(--total);color:var(--txblue)}
.summary .tot td:last-child{background:var(--result);color:#7a5a00}
.summary .num{text-align:right}
.summary th{background:var(--brand);color:#fff;font-weight:700;font-size:12px;padding:7px 9px;border:1px solid var(--brand);text-align:left}
.summary.sprav{width:100%;table-layout:fixed}
.summary.sprav th:nth-child(1){width:34%}
.summary.sprav th:nth-child(2){width:22%}
.summary.sprav th:nth-child(3){width:44%}
.summary.sprav .cmt{color:#666;font-size:12px;background:#fff}
.summary.sprav tr.sec td{background:var(--total);color:var(--txblue);font-weight:800;font-size:13px;padding:6px 9px}
.summary.proj th{background:var(--brand);color:#fff;font-weight:700;font-size:12px;padding:7px 9px;border:1px solid var(--brand);text-align:left}
.summary.proj td{white-space:nowrap}
.summary.proj .num{text-align:right}
.summary.costcmp{width:100%;table-layout:fixed}
.summary.costcmp th:nth-child(1){width:34%}
.summary.costcmp th:nth-child(2){width:33%;text-align:center}
.summary.costcmp th:nth-child(3){width:33%;text-align:center}
.summary.costcmp td.num{text-align:center}
.summary.costcmp td:first-child{text-align:center}
.summary.cc{width:100%;table-layout:fixed}
.summary.cc col.c1{width:58%}
.summary.cc col.c2{width:42%}
.summary.cc td:nth-child(2),.summary.cc .num{text-align:center;font-variant-numeric:tabular-nums}
.summary.cc tr td:first-child{background:var(--label);color:#333;font-weight:600;white-space:normal}
.summary.cc td{white-space:normal}
.detail{width:100%;border-collapse:collapse;margin-top:8px}
.detail th{background:var(--headbar);color:#333;text-align:left;font-size:12px;padding:7px;border:1px solid var(--ln);font-weight:600}
.detail td{padding:6px 7px;border:1px solid var(--ln);vertical-align:top;font-size:13px}
.detail tr:nth-child(even) td{background:var(--striped)}
.detail td.l{min-width:210px}
.detail td.mat{min-width:150px;color:#333}
/* сводная таблица ИТОГ (роль 5 debug) */
.itog table{min-width:720px}
.itog th:first-child,.itog td:first-child{white-space:nowrap}
.itog .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.itog-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.itog-bar .btn{margin-top:0}
.detail .num{text-align:right;white-space:nowrap}
.sub{margin:16px 0 4px;font-size:14.5px;color:var(--brand)}
.bp{cursor:help;color:#7A5A00}
.ed{border:1px solid var(--ln);border-radius:5px;padding:3px 5px;font:inherit;background:#FFFDF4;width:100%;min-width:80px}
.row{display:flex;gap:14px;align-items:center;margin-top:10px}
textarea.ed{resize:vertical}

/* --- шапка как в Excel («Калькулятор»): две таблицы в соседних div --- */
form.xls{max-width:1640px;padding:0;overflow:visible;border-radius:8px}
.xls-title{background:var(--brand);color:#fff;font-weight:800;font-size:16px;letter-spacing:.4px;
  text-align:center;padding:10px 12px;border-radius:8px 8px 0 0;overflow:hidden}
/* блок «СТОИМОСТЬ КВАРТИРЫ» для роли 7 (учредители) — палитра как в листе «Калькулятор»
   (тёмно-бирюзовый #0A5A79, светло-серый #F2F4F7, красный #CC0000, Arial) */
.founder{background:#fff;border:1px solid #0A5A79;margin:10px 14px 2px;overflow:hidden;
  font-family:Arial,Helvetica,sans-serif;box-shadow:0 1px 3px rgba(10,90,121,.18)}
.founder .f-row{display:grid;grid-template-columns:210px minmax(0,1fr) 220px minmax(0,1fr) minmax(0,1.1fr);
  align-items:stretch;border-bottom:1px solid #97A2B3}
.founder .f-row:last-child{border-bottom:none}
.founder .f-cell{border-right:1px solid #97A2B3;min-height:40px;padding:7px 10px;
  display:flex;align-items:center;box-sizing:border-box}
.founder .f-cell:last-child{border-right:none}
.founder .f-cell.span2{grid-column:span 2}
.founder .f-cell.lab{background:#F2F4F7;color:#0F3372;font-weight:700;font-size:12px;line-height:1.25}
.founder .f-cell.inp{background:#fff}
.founder .f-cell.out{background:#CC0000;color:#fff;font-weight:800;font-size:15px;text-align:center;justify-content:center;white-space:nowrap}
.founder .f-cell.empty{background:#fff}
.founder .f-row.r1 .f-cell.title{background:#0A5A79;color:#fff;font-weight:800;
  font-size:13px;text-align:center;letter-spacing:.4px;justify-content:center;line-height:1.25}
.founder .f-row.r-btns{display:flex;align-items:center;gap:10px;padding:8px 10px;background:#F7F9FB}
.founder input[type=number]{width:100%;box-sizing:border-box;border:1px solid #B9C4D4;border-radius:3px;
  padding:5px 7px;font-size:14px;font-weight:700;color:#191919;background:#fff;text-align:right}
.founder input.f-red-in{background:#CC0000;color:#fff;border-color:#CC0000}
.xls-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,auto);gap:12px;padding:12px 14px 4px;
  background:#fff;border-bottom:1px solid var(--headbar);align-items:stretch}
.xlscard{display:flex;align-items:stretch;min-width:0}
.xlscard.right{min-width:0;max-width:360px}
.xls-grid{flex:1 1 auto;display:flex;align-items:stretch;padding:0}
/* таблица параметров */
.params-tbl{border-collapse:collapse;width:100%;table-layout:fixed}
.params-tbl td.param{border:1px solid var(--headbar);padding:0;height:52px;background:#fff;position:relative}
.param .p-in{display:flex;flex-direction:row;align-items:stretch;height:100%}
.param .p-lbl{background:var(--headbar);color:var(--txblue);font-weight:700;font-size:10.5px;
  padding:7px 9px;text-align:center;letter-spacing:.2px;line-height:1.25;
  flex:0 0 42%;display:flex;align-items:center;justify-content:center}
.param .p-ctl{flex:1 1 auto;padding:5px 7px;display:flex;align-items:center}
.param .p-ctl select,.param .p-ctl input[type=date],.param .p-ctl input[type=number]{width:100%;
  background:var(--input);border:1px solid var(--ln);border-radius:4px;padding:6px 7px;font:inherit;font-weight:500}
.param .val{flex:1 1 auto;background:#F2F4F7;color:var(--tx);padding:6px 8px;font-weight:600;text-align:center;
  border:1px solid #E4E8F0;border-radius:4px;min-height:33px;display:flex;align-items:center;justify-content:center}
/* вертикальная ячейка (значение под подписью): дата и вид договора */
.param.v .p-in{flex-direction:column;position:absolute;top:0;left:0;right:0;bottom:0;height:auto}
.param.v .p-lbl{flex:1 1 0%;width:100%;justify-content:center;font-size:12px;line-height:1.15;padding:3px 2px;letter-spacing:0}
.param.v.date-lab .p-lbl{font-size:14px;line-height:1.1}
.param.v.vid-lab .p-lbl{font-size:15px;white-space:nowrap;line-height:1.2}
.param.v .p-ctl{flex:1 1 0%;width:100%;padding:5px 6px;align-items:center}
.param.v .p-ctl select,.param.v .p-ctl input[type=date]{font-size:12px;padding:5px 6px}
/* сузить вертикальные колонки «Дата заключения договора» и «Вид договора» —
   чтобы не торчали слишком широкими по ~20% шапки */
.params-tbl td:nth-child(4){width:150px}
.params-tbl td:nth-child(5){width:160px}
/* кастомный выпадающий список «ВИД ОТДЕЛКИ»: значение переносится на 2 строки */
.vid-dd{position:relative;display:block;width:100%}
.vid-dd .vid-btn{width:100%;display:flex;align-items:center;justify-content:space-between;gap:4px;
  background:var(--input);border:1px solid var(--ln);border-radius:4px;padding:6px 8px;
  font:inherit;font-weight:500;text-align:left;cursor:pointer;line-height:1.15;letter-spacing:0}
.vid-dd .vid-lbl{flex:1 1 auto;white-space:normal;overflow-wrap:break-word;word-break:normal}
.vid-dd .vid-caret{flex:0 0 auto;font-size:10px;color:var(--mut)}
.vid-dd .vid-sel{position:absolute!important;opacity:0;pointer-events:none;width:1px!important;height:1px;border:0;padding:0}
.vid-dd .vid-list{display:none;position:absolute;z-index:60;left:0;right:0;top:100%;margin-top:3px;
  background:#fff;border:1px solid var(--ln);border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,.15);
  max-height:230px;overflow:auto}
.vid-dd .vid-list.open{display:block}
.vid-dd .vid-opt{padding:7px 9px;font-size:12px;cursor:pointer;white-space:normal;line-height:1.15}
.vid-dd .vid-opt:hover{background:var(--headbar)}
.vid-dd .vid-opt.on{background:#eef2ff;font-weight:700}
/* таблица стоимости (отдельный соседний div) */
.cost-tbl{table-layout:fixed;border-collapse:collapse;white-space:nowrap;height:100%;width:100%}
.cost-tbl td{border:1px solid var(--brand);padding:8px 6px;vertical-align:middle;height:1px}
.cost-tbl .c-lbl{background:var(--brand);color:#fff;font-weight:700;font-size:11px;text-align:center;
  line-height:1.3;white-space:normal;padding:10px 5px}
.cost-tbl .c-val{background:var(--result);color:#D1382D;font-weight:800;font-size:14px;text-align:center;
  white-space:normal;padding:6px 4px}
.xls-sec{background:var(--brand);color:#fff;font-weight:800;font-size:14px;letter-spacing:.3px;
  text-align:center;padding:8px 12px;margin:14px 10px 8px;border-radius:4px}
/* на узких/средних ширинах правая колонка стоимости складывается под параметры,
   чтобы не налезать на «Комнат» и не перекрывать стрелку ▾ ВИД ОТДЕЛКИ */
@media (max-width:1500px){
  .xls-head{grid-template-columns:1fr}
}
@media (max-width:1100px){
  .xls-table{min-width:1100px}
}

/* --- альбомная таблица результата --- */
.tblwrap{overflow-x:auto}
.xls-table{min-width:0;width:auto;border-collapse:collapse;table-layout:fixed}
.xls-table th{white-space:normal;background:var(--headbar);color:var(--txblue);font-weight:700;
  font-size:10.5px;padding:7px 8px;border:1px solid var(--ln);text-align:center;line-height:1.2;vertical-align:middle;overflow-wrap:break-word}
.xls-table td{padding:6px 8px;border:1px solid var(--ln);vertical-align:top;font-size:12.5px}
.xls-table .c{text-align:center;white-space:nowrap}
.xls-table .num{text-align:right;white-space:nowrap}
.xls-table td.l{min-width:230px}
.xls-table td.mat{min-width:150px;color:#333}
.xls-table tr:nth-child(even) td{background:var(--striped)}
.xls-table tr.tot td{background:var(--total);color:var(--txblue);font-weight:700}
.xls-table tr.tot td:last-child{background:var(--total)}
/* --- фиксация шапки таблицы при прокрутке длинного списка позиций --- */
/* таблица с множеством позиций становится вертикальной зоной прокрутки,
   а строка названий колонок «липнет» к верху этой зоны (не уезжает при скролле).
   .tblwrap (overflow-x:auto) задаёт горизонталь; здесь добавляем вертикаль+высоту. */
.detailw,.itogw{overflow-y:auto;max-height:min(62vh,820px)}
.detail.xls-table thead th,
#itog-table thead th{position:sticky;top:0;z-index:5;box-shadow:0 1px 0 var(--ln)}
.foot{max-width:1060px;margin:0 auto;text-align:center;color:var(--mut);font-size:12px}
/* --- вкладка «Матрицы» (роль 6) --- */
.mx-bar{flex-wrap:wrap;align-items:flex-end}
.mx-bar label{flex-direction:column}
.mx-bar .btn{margin-top:0}
.mx-bar select,.mx-bar .btn{height:34px;box-sizing:border-box}
.mx-bar .mx-del{background:#D1382D}
.mx-bar .mx-del:hover{background:#B32E23}
.mx-bar .mx-file{display:flex;flex-direction:column;gap:3px;justify-content:flex-end;font-size:12px;color:var(--mut);font-weight:600}
.mx-modal{position:fixed;inset:0;background:rgba(15,25,45,.45);z-index:999;display:flex;align-items:center;justify-content:center}
.mx-modal-box{background:#fff;border-radius:10px;max-width:420px;width:92%;padding:20px 22px;box-shadow:0 6px 28px rgba(0,0,0,.25)}
.mx-modal-title{font-weight:800;font-size:16px;color:#0A5A79;margin-bottom:8px}
.mx-modal-text{color:#333;font-size:14px;line-height:1.45;margin-bottom:16px}
.mx-modal-btns{display:flex;justify-content:flex-end;gap:10px}
.mx-bar .mx-file input[type=file]{font:inherit;font-size:12px;padding:6px;border:1px solid var(--ln);border-radius:6px;background:#fff}
.mx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;margin:6px 0 14px}
.mx-field{display:flex;flex-direction:column;gap:3px}
.mx-field label{font-weight:600}
.mx-wrap{overflow-x:auto;margin-top:8px}
.mx-mat{min-width:900px}
.mx-mat th,.mx-mat td{white-space:nowrap}
.mx-mat .mx-code{font-weight:700;color:var(--txblue);background:var(--sec-blue)}
.mx-mat th.mx-plan{text-align:center}
#tab-матрицы .mx-mat input.ed{min-width:70px;width:70px}
#tab-матрицы .mx-comp input.ed{width:100%}
#tab-матрицы .mx-comp td:nth-child(1){width:34px}
#tab-матрицы .mx-comp td:nth-child(2){width:90px}
#tab-матрицы .mx-comp td:nth-child(3){width:210px}
#tab-матрицы .mx-comp td:nth-child(4){width:150px}
#tab-матрицы .mx-comp td:nth-child(5){width:110px}
#tab-матрицы .mx-comp td:nth-child(6){width:180px}
.mx-newrow td{background:#FFF8E1!important}
`;

const JS = `
var DBG = __DEBUG__;
var DUMP = __DUMP__;
function decode(s){try{return decodeURIComponent(s)}catch(e){return s}}
// копирование дампа таблицы «как в Excel» (роль 5 debug)
function copyDump(){
  var btn=document.getElementById('copybtn');
  if(!DUMP){ if(btn){btn.textContent='Нет данных для копирования';} return; }
  function flash(){
    if(!btn) return;
    btn.textContent='Скопировано ✓';
    setTimeout(function(){ btn.textContent='📋 Скопировать'; },1600);
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(DUMP).then(flash,function(){
      // fallback: если нет разрешения на clipboard API
      var ta=document.createElement('textarea');ta.value=DUMP;
      ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.focus();ta.select();
      try{document.execCommand('copy');flash();}catch(e){}
      document.body.removeChild(ta);
    });
  } else {
    var ta=document.createElement('textarea');ta.value=DUMP;
    ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.focus();ta.select();
    try{document.execCommand('copy');flash();}catch(e){}
    document.body.removeChild(ta);
  }
}
// авто-пересчёт: GET-запрос на внешний эндпойнт + отправка формы
function recalc(){
  try{ fetch('https://romach.space/lisp/hello', {mode:'no-cors'}).catch(function(){}); }catch(e){}
  var f=document.getElementById('calc'); if(f) f.submit();
  return true;
}
/* кастомный селект «ВИД ОТДЕЛКИ»: показ полного значения (перенос на 2 строки) */
function vidToggle(e){ if(e){e.preventDefault();e.stopPropagation();}
  var l=document.getElementById('vidList'); if(l) l.classList.toggle('open'); return false; }
function vidPick(v){
  var s=document.getElementById('vidSel'); if(s) s.value=v;
  var lb=document.getElementById('vidLbl'); if(lb) lb.textContent=v;
  var l=document.getElementById('vidList'); if(l) l.classList.remove('open');
  recalc(); return false; }
document.addEventListener('click',function(e){
  if(!e.target.closest || !e.target.closest('.vid-dd')){
    var l=document.getElementById('vidList'); if(l) l.classList.remove('open');
  }
});
document.addEventListener('copy',function(e){ if(!DBG){e.preventDefault();return false;} });
document.addEventListener('cut',function(e){ if(!DBG){e.preventDefault();return false;} });
document.addEventListener('dragstart',function(e){ if(!DBG){e.preventDefault();return false;} });
// вкладки
(function(){
  var btns=document.querySelectorAll('.tb');
  var ids=['калькулятор','расчёт','справочник','итог','матрицы'];
  function show(id){
    ids.forEach(function(t){var el=document.getElementById('tab-'+t);if(el)el.style.display=(t===id)?'block':'none';});
    btns.forEach(function(b){b.classList.toggle('on',b.getAttribute('data-tab')===id);});
  }
  btns.forEach(function(b){b.addEventListener('click',function(){show(b.getAttribute('data-tab'));});});
  show(__INIT_TAB__);
})();
// ИТОГ (роль 5): пересчёт всех комбинаций + копирование сводной таблицы
function escIt(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
async function itogRecalc(){
  var btn=document.getElementById('itogrecalc');
  if(btn){btn.disabled=true;btn.textContent='Пересчитываю…';}
  try{
    var resp=await fetch('./itog',{headers:{'X-Vibe-No-Cache':'1'}});
    var j=await resp.json();
    if(!j||!j.ok){throw new Error('bad resp');}
    var tb=document.querySelector('#itog-table tbody');
    if(!tb){btn.disabled=false;btn.textContent='Ошибка';return;}
    var h='';
    j.rows.forEach(function(r){
      h+='<tr><td>'+escIt(r.proj)+'</td><td>'+escIt(r.plan)+'</td><td>'+escIt(r.vid)+'</td><td>'+escIt(r.sc)+'</td>'
        +'<td class="num">'+Number(r.totalCost).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+'</td>'
        +'<td class="num">'+Number(r.cost_m2).toLocaleString('ru-RU',{maximumFractionDigits:2})+'</td>'
        +'<td class="num">'+Number(r.sale).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+'</td>'
        +'<td class="num">'+Number(r.per_m2).toLocaleString('ru-RU',{maximumFractionDigits:2})+'</td></tr>';
    });
    tb.innerHTML=h;
    if(btn){btn.disabled=false;btn.textContent='🔄 Пересчитать ✓';setTimeout(function(){btn.textContent='🔄 Пересчитать';},1200);}
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Ошибка';}
  }
}
function itogCopy(){
  var tbl=document.getElementById('itog-table');if(!tbl)return;
  var TAB=String.fromCharCode(9), NL=String.fromCharCode(10);
  var rows=[].map.call(tbl.querySelectorAll('tr'),function(tr){
    return [].map.call(tr.querySelectorAll('th,td'),function(c){return c.textContent.trim();}).join(TAB);
  });
  var t=rows.join(NL);
  var btn=document.getElementById('itogcopy');
  function flash(){if(!btn)return;btn.textContent='Скопировано ✓';setTimeout(function(){btn.textContent='📋 Скопировать таблицу';},1500);}
  function fallback(){
    var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.focus();ta.select();
    try{document.execCommand('copy');flash();}catch(e){}
    document.body.removeChild(ta);
  }
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(flash,fallback);}
  else fallback();
}
document.addEventListener('DOMContentLoaded',function(){
  var ir=document.getElementById('itogrecalc');if(ir)ir.addEventListener('click',itogRecalc);
  var ic=document.getElementById('itogcopy');if(ic)ic.addEventListener('click',itogCopy);
});
async function saveEdits(vid){
  var rows={};document.querySelectorAll('.ed[data-no]').forEach(function(el){
    var no=el.getAttribute('data-no'),k=el.getAttribute('data-kind');
    rows[no]=rows[no]||{}; var v=el.value;
    if(k==='volume')v=parseFloat(v);
    if(k==='price')v=(v==='')?null:parseFloat(v);
    rows[no][k]=v;
  });
  var st=document.getElementById('save-status');
  st.textContent='Сохранение…';
  try{
    var res=await fetch('./save',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({vid:vid,rows:rows})});
    var j=await res.json();
    st.textContent=j.ok?('Сохранено ✓ '+new Date().toLocaleTimeString('ru-RU')):('Ошибка: '+j.error);
  }catch(e){st.textContent='Ошибка сети';}
}
async function saveSprav(){
  var values=[];document.querySelectorAll('.s-num').forEach(function(el){
    var v=el.value;
    if(el.getAttribute('data-pct')==='1'&&v!==''){v=String(parseFloat(v)/100);}
    values.push([el.getAttribute('data-path'),v]);
  });
  var st=document.getElementById('sprav-status');
  st.textContent='Сохранение…';
  try{
    var res=await fetch('./save-sprav',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({values:values})});
    var j=await res.json();
    st.textContent=j.ok?('Сохранено ✓ '+new Date().toLocaleTimeString('ru-RU')):('Ошибка: '+j.error);
  }catch(e){st.textContent='Ошибка сети';}
}
// роль 6 (матрица К): сохранить коэффициенты вкладки «Матрица К»
async function saveMatrixK(){
  var values=[];document.querySelectorAll('.kk-num').forEach(function(el){
    var v=el.value;
    if(v!==''){var f=parseFloat(v); if(!isNaN(f)) values.push([el.getAttribute('data-kpath'),f]);}
    else values.push([el.getAttribute('data-kpath'),null]);
  });
  var st=document.getElementById('matrixk-status');
  st.textContent='Сохранение…';
  try{
    var res=await fetch('./save-matrixk',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({values:values})});
    var j=await res.json();
    st.textContent=j.ok?('Сохранено ✓ '+new Date().toLocaleTimeString('ru-RU')):('Ошибка: '+j.error);
  }catch(e){st.textContent='Ошибка сети';}
}
// роль 6 (матрицы): собрать все правки вкладки «Матрицы» и сохранить
async function saveMatrix(){
  var params={},volumes={},wash={},rows={},newRowCols={},npFields=[];
  document.querySelectorAll('[data-mx="param"]').forEach(function(el){
    var pl=el.getAttribute('data-plan'),f=el.getAttribute('data-field');
    params[pl]=params[pl]||{}; params[pl][f]=(el.value==='')?null:parseFloat(el.value);
  });
  document.querySelectorAll('[data-mx="wash"]').forEach(function(el){
    var pl=el.getAttribute('data-plan'),f=el.getAttribute('data-field');
    wash[pl]=wash[pl]||{}; wash[pl][f]=(el.value==='')?null:parseFloat(el.value);
  });
  document.querySelectorAll('[data-mx="vol"]').forEach(function(el){
    var code=el.getAttribute('data-code'),pl=el.getAttribute('data-plan');
    volumes[code]=volumes[code]||{}; volumes[code][pl]=(el.value==='')?null:parseFloat(el.value);
  });
  document.querySelectorAll('[data-mx="row"]').forEach(function(el){
    var vid=el.getAttribute('data-vid'),no=el.getAttribute('data-no'),f=el.getAttribute('data-field');
    var num=(el.getAttribute('data-num')==='1');
    rows[vid]=rows[vid]||{}; rows[vid][no]=rows[vid][no]||{}; rows[vid][no].no=parseInt(no,10);
    rows[vid][no][f]= num?((el.value==='')?null:parseFloat(el.value)) : el.value;
  });
  document.querySelectorAll('[data-mx="newrow"]').forEach(function(el){
    var vid=el.getAttribute('data-vid'),f=el.getAttribute('data-field');
    var num=(el.getAttribute('data-num')==='1');
    newRowCols[vid]=newRowCols[vid]||{};
    newRowCols[vid][f]= num?((el.value==='')?null:parseFloat(el.value)) : el.value;
  });
  document.querySelectorAll('[data-mx="np"]').forEach(function(el){
    npFields.push([el.getAttribute('data-field'),(el.value==='')?null:parseFloat(el.value)]);
  });
  var newPlan=null;var npName=document.querySelector('.mx-np-name');
  if(npName && npName.value) newPlan={name:npName.value,fields:npFields};
  var payload={params:params,volumes:volumes,wash:wash,rows:rows,newRow:newRowCols,newPlan:newPlan};
  var st=document.getElementById('mx-status');
  if(st) st.textContent='Сохранение…';
  try{
    var res=await fetch('./save-matrix',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    var j=await res.json();
    if(j.ok){ if(st) st.textContent='Сохранено ✓'; setTimeout(function(){window.location.reload();},300); }
    else { if(st) st.textContent='Ошибка: '+j.error; }
  }catch(e){ if(st) st.textContent='Ошибка сети'; }
}
// роль 6: импорт нового проекта из xlsx-болванки
async function importProject(){
  var inp=document.getElementById('mx-import-file');
  var st=document.getElementById('mx-status');
  if(!inp||!inp.files||!inp.files[0]){ if(st)st.textContent='Выберите файл .xlsx'; return; }
  var f=inp.files[0];
  if(st)st.textContent='Импортирую…';
  try{
    var buf=await f.arrayBuffer();
    var res=await fetch('./import-project',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:buf});
    var j=await res.json();
    if(j&&j.ok){ if(st)st.textContent='Проект "'+j.project+'" импортирован ✓'; setTimeout(function(){window.location='?tab=матрицы&project='+encodeURIComponent(j.project);},400); }
    else { if(st)st.textContent='Ошибка: '+(j&&j.error||'неизвестная'); }
  }catch(e){ if(st)st.textContent='Ошибка сети'; }
}
// роль 6: удаление текущего проекта
function delProject(){
  var sel=document.querySelector('select[name=mx-project]');
  if(!sel)return;
  var p=sel.value;
  var tx=document.getElementById('mx-modal-text');
  if(tx)tx.textContent='Удалить проект "'+p+'"? Это повлияет на расчёт для всех пользователей.';
  var md=document.getElementById('mx-modal');
  if(md)md.style.display='flex';
}
function closeMxModal(){
  var md=document.getElementById('mx-modal');
  if(md)md.style.display='none';
}
async function doDelProject(){
  var sel=document.querySelector('select[name=mx-project]');
  if(!sel)return;
  var p=sel.value;
  var st=document.getElementById('mx-status'); if(st)st.textContent='Удаляю…';
  closeMxModal();
  try{
    var res=await fetch('./delete-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:p})});
    var j=await res.json();
    if(j&&j.ok){ if(st)st.textContent='Проект удалён ✓'; setTimeout(function(){window.location.reload();},300); }
    else { if(st)st.textContent='Ошибка: '+(j&&j.error||'неизвестная'); }
  }catch(e){ if(st)st.textContent='Ошибка сети'; }
}
// роль 7 (учредители): живой пересчёт «Цены квартиры по договору без отделки, ₽/1 кв м»
function founderRecompute(){
  var box=document.querySelector('.founder'); if(!box) return;
  var sale=box.querySelector('input[data-f="sale"]'); if(!sale) return;
  var down=box.querySelector('input[data-f="down"]');
  var out=box.querySelector('[data-f-out="perM2"]');
  var sv=parseFloat(sale.value), dv=parseFloat(down?down.value:''),
      fn=parseFloat(box.getAttribute('data-f-fin')||''), S=parseFloat(box.getAttribute('data-f-s')||'');
  var v=null;
  if(!isNaN(sv)&&!isNaN(dv)&&!isNaN(fn)&&!isNaN(S)&&S>0){ v=(sv-fn-dv)/S; }
  if(out) out.textContent = (v==null) ? '—' : v.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
}
// роль 7 (учредители): авто-сохранение вводных значений (продажа, взнос) с debounce
var founderSaveTimer=null;
function founderAutoSave(){
  if(founderSaveTimer) clearTimeout(founderSaveTimer);
  founderSaveTimer=setTimeout(saveFounderNow,600);
}
async function saveFounderNow(){
  var sale=document.querySelector('.founder input[data-f="sale"]');
  var down=document.querySelector('.founder input[data-f="down"]');
  if(!sale||!down) return;
  var payload={};
  if(sale.value!=='') payload.sale=parseFloat(sale.value);
  if(down.value!=='') payload.down=parseFloat(down.value);
  try{
    var res=await fetch('./save-founder',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)});
    await res.json();
  }catch(e){}
}
`;

// ---------- handlers ----------
function readUser(req) {
  let id = req.headers['x-vibe-user-id'] || '';
  let enc = req.headers['x-vibe-user-name-encoded'];
  let name = '';
  if (enc) { try { enc = decodeURIComponent(enc); } catch (e) {} name = enc; }
  else name = req.headers['x-vibe-user-name'] || '';
  return { id, name };
}
function parse(qs) {
  const u = new URLSearchParams(qs || '');
  return {
    project: u.get('project') || 'RED/SKY',
    planning: u.get('planning') || '',
    vid: u.get('vid') || '',
    scenario: u.get('scenario') || 'ДДУ/ДКП',
    srok: u.get('srok') || '0 лет',
    rent: u.get('rent') || 'Да (рентабельность достигнута)',
    date: u.get('date') || (new Date(Date.now() - (new Date().getTimezoneOffset()*60000)).toISOString().slice(0,10)),
    rooms: u.get('rooms'),
    tab: u.get('tab') || 'калькулятор'
  };
}

const server = http.createServer((req, res) => {
  (async () => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (url.pathname === '/auth/bitrix' && req.method === 'POST') return bitrix.authenticate(req, res);
    const u = bitrix.identity(req, url);
    if (!u) {
      const isPage = url.pathname === '/' && (req.method === 'GET' || req.method === 'POST');
      res.writeHead(isPage ? 200 : 401, {'Content-Type': isPage ? 'text/html; charset=utf-8' : 'application/json'});
      return res.end(isPage ? bitrix.bootstrap() : JSON.stringify({ok:false,error:'Требуется вход через Bitrix24'}));
    }
    const map = await loadRoles(); // сервер → config (или fallback config)
    const idNum = (u.id != null && String(u.id) !== '') ? Number(u.id) : NaN;
    const caps = capsFor(map, idNum);
    if (DEBUG_USERS.includes(idNum)) caps.add('5'); // роль 5 (debug) — серверно, независимо от внешнего сервиса
    if (MATRIX_USERS.includes(idNum)) caps.add('6'); // роль 6 (матрицы) — серверно, независимо от внешнего сервиса
    if (FOUNDER_USERS.includes(idNum)) caps.add('7'); // роль 7 (учредители) — серверно, независимо от внешнего сервиса
    const role = roleFromCaps(caps, idNum, (idNum && USERS[String(idNum)]) || u.name);
    if (req.method === 'POST' && url.pathname === '/save-finance8') return finance8.save(req, res, role);
    const data = currentData();

    if (req.method === 'POST' && url.pathname === '/save') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        if (!role.editMaterials) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'Нет прав (роль 3)'})); }
      let obj; try { obj = JSON.parse(body); } catch (e) { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'bad json'})); }
      const vid = obj.vid; const rows = obj.rows || {};
      if (!data.compositions[vid]) { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'unknown vid'})); }
      EDITED.compositions = EDITED.compositions || {};
      EDITED.compositions[vid] = EDITED.compositions[vid] || [];
      const map = {};
      for (const r of EDITED.compositions[vid]) map[r.no] = r;
      for (const no of Object.keys(rows)) {
        const r = map[no] || (map[no] = {});
        r.no = Number(no);            // без `no` внутри объекта currentData() не находит строку — правки не применялись
        const ed = rows[no] || {};
        // Роль 3 (editMaterials) правит ТОЛЬКО себестоимость (price). Наименование и объём работ не изменяются.
        if (ed.price != null) r.price = ed.price; else if (ed.price === null) r.price = null;
      }
      EDITED.compositions[vid] = Object.keys(map).sort((a,b)=>a-b).map(k=>map[k]);
      persistEdited();
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/save-sprav') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (!role.editCost) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'Нет прав (роль 4)'})); }
      let obj; try { obj = JSON.parse(body); } catch (e) { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'bad json'})); }
      const pairs = Array.isArray(obj.values) ? obj.values : [];
      const nst = {};
      for (const [path, valStr] of pairs) {
        if (!path) continue;
        if (!/^[a-zA-Zа-яА-ЯёЁ0-9._]+$/.test(path)) continue; // путь из ключей и индексов
        const parts = path.split('.');
        let node = nst;
        for (let i = 0; i < parts.length - 1; i++) { node[parts[i]] = node[parts[i]] || {}; node = node[parts[i]]; }
        const key = parts[parts.length - 1];
        node[key] = (valStr === '' || valStr == null) ? null : Number(valStr);
      }
      SPRAV_ED = nst;
      persistSprav();
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/save-matrixk') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (!role.editMatrix) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'Нет прав (роль 6)'})); }
      let obj; try { obj = JSON.parse(body); } catch (e) { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'bad json'})); }
      const pairs = Array.isArray(obj.values) ? obj.values : [];
      const nst = {};
      const ALLOWED = /^(k1|k2|k3|k4)(\.[^.]*)?(\.k)?$/;
      for (const [path, val] of pairs) {
        if (!path || !ALLOWED.test(String(path))) continue;
        const parts = String(path).split('.');
        let node = nst;
        for (let i = 0; i < parts.length - 1; i++) { node[parts[i]] = node[parts[i]] || {}; node = node[parts[i]]; }
        const key = parts[parts.length - 1];
        if (val === null || val === undefined || val === '') { delete node[key]; }
        else { const f = Number(val); node[key] = isNaN(f) ? node[key] : f; }
      }
      MATRIXK_ED = nst;
      persistMatrixK();
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/save-matrix') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (!role.editMatrix) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'Нет прав (роль 6)'})); }
      let obj; try { obj = JSON.parse(body); } catch (e) { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'bad json'})); }
      const project = obj.project || '';
      if (!project || !data.projects[project]) { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'unknown project'})); }
      MATRIX_ED.projects = MATRIX_ED.projects || {};
      const pe = MATRIX_ED.projects[project] || (MATRIX_ED.projects[project] = {});
      // params (существующие + новая планировка через newPlan)
      if (isObj(obj.params)) {
        pe.params = pe.params || {};
        for (const pl of Object.keys(obj.params)) {
          if (!data.projects[project].params[pl]) continue;
          const sub = obj.params[pl];
          if (!isObj(sub)) continue;
          pe.params[pl] = pe.params[pl] || {};
          for (const k of Object.keys(sub)) {
            if (!PARAM_KEYS.has(k)) continue;
            const v = sub[k];
            pe.params[pl][k] = (v == null || v === '') ? null : Number(v);
          }
        }
      }
      // wash
      if (isObj(obj.wash)) {
        pe.wash = pe.wash || {};
        for (const pl of Object.keys(obj.wash)) {
          if (!data.projects[project].params[pl]) continue;
          const sub = obj.wash[pl];
          if (!isObj(sub)) continue;
          pe.wash[pl] = pe.wash[pl] || {};
          for (const k of Object.keys(sub)) {
            if (!WASH_KEYS.has(k)) continue;
            const v = sub[k];
            pe.wash[pl][k] = (v == null || v === '') ? null : Number(v);
          }
        }
      }
      // volumes
      if (isObj(obj.volumes)) {
        pe.volumes = pe.volumes || {};
        for (const code of Object.keys(obj.volumes)) {
          const inVals = obj.volumes[code];
          if (!isObj(inVals)) continue;
          pe.volumes[code] = pe.volumes[code] || {};
          for (const pl of Object.keys(inVals)) {
            if (!data.projects[project].params[pl]) continue;
            const v = inVals[pl];
            if (v == null || v === '') pe.volumes[code][pl] = null;
            else { const n = Number(v); pe.volumes[code][pl] = Number.isFinite(n) ? n : null; }
          }
        }
      }
      // новая планировка
      if (isObj(obj.newPlan) && obj.newPlan.name) {
        const nm = String(obj.newPlan.name).trim();
        if (nm && !data.projects[project].params[nm]) {
          pe.params = pe.params || {};
          const pp = pe.params[nm] = {};
          const fields = Array.isArray(obj.newPlan.fields) ? obj.newPlan.fields : [];
          for (const [k, v] of fields) {
            if (!PARAM_KEYS.has(k) || v == null || v === '') continue;
            pp[k] = Number(v);
          }
        }
      }
      // строки работ (существующие)
      if (isObj(obj.rows)) {
        MATRIX_ED.compositions = MATRIX_ED.compositions || {};
        for (const vid of Object.keys(obj.rows)) {
          if (!data.compositions[vid]) continue;
          const set = MATRIX_ED.compositions[vid] = MATRIX_ED.compositions[vid] || {};
          set.rows = set.rows || [];
          const byNo = {};
          for (const r of set.rows) byNo[r.no] = r;
          for (const no of Object.keys(obj.rows[vid])) {
            const src = obj.rows[vid][no];
            if (!isObj(src)) continue;
            const r = byNo[no] = byNo[no] || {};
            r.no = Number(no);
            r._null = true; // флаг: строка присутствует в наборе (мы храним полный набор vid)
            for (const k of Object.keys(src)) {
              if (k === 'no') continue;
              if (!ROW_KEYS.has(k)) continue;
              if (k === 'price') r[k] = (src[k] == null || src[k] === '') ? null : Number(src[k]);
              else r[k] = src[k];
            }
          }
          // сохраняем только строки, реально присутствующие в форме (по `_null`-флагу сборки)
          const out = [];
          for (const no of Object.keys(byNo)) {
            const rr = byNo[no];
            if (!rr._null) { if (rr.no != null) out.push(rr); continue; }
            const merged = {};
            for (const k of Object.keys(rr)) if (k !== '_null') merged[k] = rr[k];
            out.push(merged);
          }
          set.rows = out.sort((a, b) => (a.no || 0) - (b.no || 0));
        }
      }
      // добавление новой строки работы
      if (isObj(obj.newRow)) {
        MATRIX_ED.compositions = MATRIX_ED.compositions || {};
        for (const vid of Object.keys(obj.newRow)) {
          const row = obj.newRow[vid];
          if (!row || !row.code) continue;
          if (!data.compositions[vid]) continue;
          const set = MATRIX_ED.compositions[vid] = MATRIX_ED.compositions[vid] || {};
          set.rows = set.rows || [];
          const existing = data.compositions[vid].slice();
          for (const r of set.rows) existing.push(r);
          let maxNo = 0;
          for (const r of existing) if (r.no > maxNo) maxNo = r.no;
          const nr = { no: maxNo + 1 };
          for (const k of Object.keys(row)) {
            if (k === 'code' || k === 'name' || k === 'rule' || k === 'comment') nr[k] = row[k];
            else if (k === 'price') nr[k] = (row[k] == null || row[k] === '') ? null : Number(row[k]);
          }
          set.rows.push(nr);
        }
      }
      persistMatrix();
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/save-founder') {
    if (!role.founder) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'Нет прав (роль 7)'})); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let obj; try { obj = JSON.parse(body); } catch (e) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'Некорректный JSON'})); }
      const nil = v => (v === undefined || v === null || v === '');
      const sale = nil(obj.sale) ? null : Number(obj.sale);
      const down = nil(obj.down) ? null : Number(obj.down);
      if ((sale !== null && Number.isNaN(sale)) || (down !== null && Number.isNaN(down))) {
        res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'Некорректное число'}));
      }
      FOUNDER_V.sale = sale; FOUNDER_V.down = down;
      persistFounder();
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/import-project') {
    if (!role.editMatrix) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'Нет прав (роль 6)'})); }
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 12 * 1024 * 1024) { try { res.writeHead(413, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Файл слишком большой'})); } catch(e) {} } chunks.push(c); });
    req.on('end', () => {
      try {
        const imp = importProjectFromXlsx(Buffer.concat(chunks));
        const exists = !!data.projects[imp.name];
        if (exists) {
          // проект уже есть — ПОЛНАЯ замена данными из файла (вариант B)
          MATRIX_ED.replaceProjects = MATRIX_ED.replaceProjects || {};
          MATRIX_ED.replaceProjects[imp.name] = imp.block;
          if (MATRIX_ED.newProjects && MATRIX_ED.newProjects[imp.name]) delete MATRIX_ED.newProjects[imp.name];
        } else {
          MATRIX_ED.newProjects = MATRIX_ED.newProjects || {};
          MATRIX_ED.newProjects[imp.name] = imp.block;
        }
        if (imp.price != null) { MATRIX_ED.projectPrices = MATRIX_ED.projectPrices || {}; MATRIX_ED.projectPrices[imp.name] = imp.price; }
        if (Array.isArray(MATRIX_ED.deletedProjects)) MATRIX_ED.deletedProjects = MATRIX_ED.deletedProjects.filter(x => x !== imp.name);
        persistMatrix();
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok: true, project: imp.name, replaced: exists }));
      } catch (e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/delete-project') {
    if (!role.editMatrix) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'Нет прав (роль 6)'})); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let obj; try { obj = JSON.parse(body); } catch (e) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'bad json'})); }
      const project = obj.project || '';
      if (!project || !data.projects[project]) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'unknown project'})); }
      MATRIX_ED.deletedProjects = MATRIX_ED.deletedProjects || [];
      if (!MATRIX_ED.deletedProjects.includes(project)) MATRIX_ED.deletedProjects.push(project);
      if (MATRIX_ED.newProjects && MATRIX_ED.newProjects[project]) delete MATRIX_ED.newProjects[project];
      persistMatrix();
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  if (url.pathname !== '/') {
    // ИТОГ (роль 5): JSON-эндпойнт — сводная калькуляция для кнопки «Пересчитать»
    if (url.pathname === '/itog') {
      if (!role.debug) {
        res.writeHead(403, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok:false, error:'Нет прав (роль 5)' }));
      }
      const dstr = new Date(Date.now() - (new Date().getTimezoneOffset()*60000)).toISOString().slice(0,10);
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ ok: true, rows: itogRows(data, dstr) }));
    }
    res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
    return res.end('not found');
  }

  const q = parse(url.search);
  if (role.denied) {
    res.writeHead(403, {'Content-Type':'text/html; charset=utf-8'});
    return res.end(accessDeniedPage(role));
  }
  if (!q.planning && data.projects[q.project]) { q.planning = Object.keys(data.projects[q.project].params)[0] || ''; }
  if (!q.vid) { q.vid = Object.keys(data.compositions)[0] || ''; }
  const result = (q.planning && q.vid) ? compute(data, q.project, q.planning, q.vid, q.scenario, q.srok, q.rent, q.date) : null;
  let flash = '';
  if (!u.id && !u.name) flash = 'Заголовок пользователя не определён — показан минимальный доступ (без детализации).';
  const tab = q.tab;
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
  res.end(page(uid(), role, data, q, result, flash, tab));
  })().catch(error => { console.error(error.message); if (!res.headersSent) res.writeHead(500); res.end('Internal server error'); });
});
function uid(){return Math.random().toString(36).slice(2)}
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`Калькулятор отделки запущен на порту ${PORT}`);
});
