// Сборка готовых файлов данных для дашборда.
//
// Что делает: забирает данные из тех же шести Apps Script, что дашборд дёргал из браузера,
// режет их по правам каждого логина, ужимает словарями (tools/pack.js), шифрует кодом
// доступа (tools/crypto.js) и раскладывает файлами. Дашборд потом просто скачивает свой.
//
// Запуск:
//   node tools/build_bundle.js --out out            — тянуть из Apps Script
//   node tools/build_bundle.js --from-dir raw --out out   — из сохранённых выгрузок
//
// Окружение:
//   LEADER_CODE  — код доступа руководителя, им забираются все данные
//   STORE_CODES  — JSON {"логин":"код", ...} для всех, кому собираем файл
//   OLDC_LINKS   — JSON {"логин":"ссылка", ...} на «Старые коллекции» (глава 23), для всех
//
// Коды нигде не печатаются и в собранные файлы не попадают.

const fs = require('fs');
const path = require('path');
const { pack } = require('./pack.js');
const { encryptJson } = require('./crypto.js');

const ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = 120000;
const RETRIES = 3;
// Паузы перед 2-й и 3-й попыткой. 404 от Apps Script идёт полосами: 29.09.2026 mkt.raw
// отказал трижды за 80 секунд, пока попытки шли подряд. 30 + 90 с переживают такую полосу,
// а сборку в худшем случае удлиняют на две минуты при лимите в 30.
const RETRY_PAUSES_MS = [30000, 90000];

function urlsFromIndexHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const out = {};
  for (const name of ['SALES', 'STAFF', 'FINANCE', 'MKT', 'EMPL', 'ACCESS']) {
    const m = html.match(new RegExp('var ' + name + '_GAS_URL="([^"]+)"'));
    if (!m) throw new Error('в index.html не найден адрес ' + name + '_GAS_URL');
    out[name] = m[1];
  }
  return out;
}

// Пустой список профилей не бывает правдой: 29.09.2026 Apps Script дважды ответил
// {ok:true, logins:[]}, и сборка опубликовала пустой список поверх рабочего — у всех
// на экране входа стало «Нет профилей». Такой ответ считается сбоем и переспрашивается.
function loginsProblem(j) {
  return (Array.isArray(j.logins) && j.logins.length) ? null : 'пустой список профилей';
}

// 06.10.2026 Apps Script продаж на запрос meta ответил заглушкой {ok:true, status:"alive"}
// без лет и магазинов — в «Планах продаж» опустели фильтры и отчёт перестал строиться.
// Мета проверяется теми же признаками, что hasSalesMeta/hasStaffMeta/… в index.html,
// строки — наличием rows (у заглушки его нет, и `j.rows || []` превращало её в «0 строк»).
const META_NEEDS = {
  sales: ['years', 'stores'], staff: ['stores'], empl: ['years'], mkt: ['years'], finance: [],
};
function answerProblem(key, entity, j) {
  if (entity === 'meta') {
    if (key === 'finance' && !Array.isArray(j.years)) return 'в мете нет years';
    for (const f of META_NEEDS[key] || []) {
      if (!Array.isArray(j[f]) || !j[f].length) return 'в мете нет ' + f + (j.status ? ' (ответ «' + j.status + '»)' : '');
    }
    return null;
  }
  if (!Array.isArray(j.rows)) return 'в ответе нет rows' + (j.status ? ' (ответ «' + j.status + '»)' : '');
  if (entity === 'raw' && !j.rows.length) return 'пустой raw';
  return null;
}

// Конкурс магазинов: пороги руководства и остаток на 1-е (листы книги исходников,
// свой Apps Script главы 7). Источник необязателен: пока секреты не заведены,
// сборка идёт как раньше и страница пишет «нет данных конкурса». Но если он
// настроен, пустой лист «Остаток» — сбой: публиковать пустой конкурс нельзя.
function teamcConfig() {
  if (process.env.CONTEST_GAS_URL && process.env.CONTEST_GAS_KEY) {
    return { endpoint: process.env.CONTEST_GAS_URL, key: process.env.CONTEST_GAS_KEY };
  }
  const local = path.join(ROOT, 'gas-sources.local.json');
  if (fs.existsSync(local)) {
    const c = JSON.parse(fs.readFileSync(local, 'utf8'));
    if (c.endpoint && c.key) return c;
  }
  return null;
}
function teamcProblem(j) {
  if (!j || !j.data) return 'нет data' + (j && j.status ? ' (ответ «' + j.status + '»)' : '');
  if (!j.data.stock || !Array.isArray(j.data.stock.rows) || !j.data.stock.rows.length) return 'лист «Остаток» пуст';
  if (!j.data.thresholds || !Array.isArray(j.data.thresholds.rows)) return 'нет листа «Пороги»';
  return null;
}
// Число из ячейки листа: пробелы и неразрывные пробелы (разделители тысяч) убираются, запятая — точка.
function teamcNum(v) {
  const s = String(v == null ? '' : v).replace(/[\s\u00a0]/g, '');
  return s === '' ? '' : Number(s.replace(',', '.'));
}
// Листы правят руками: кривая строка порога или остатка молча испортила бы места.
// Сборку останавливаем с понятным текстом, где именно ошибка (номер строки — как в листе, шапка — строка 1).
const TEAMC_MONTH = /^\d{4}-\d{2}$/;
const TEAMC_TYPES = ['бренд', 'группа'];
function teamcRowsProblem(rows) {
  const bad = [];
  rows.thr.forEach((t, i) => {
    const at = 'лист «Пороги», строка ' + (i + 2) + ' (' + (t.pos || 'без позиции') + '): ';
    if (!TEAMC_TYPES.includes(t.type)) bad.push(at + 'Тип «' + t.type + '» — нужно «бренд» или «группа»');
    for (const [f, col] of [['four', 'Четвёрка'], ['outlet', 'Аутлет'], ['above', 'Above']]) {
      const v = t[f];
      if (v !== '' && !(Number.isInteger(v) && v >= 1)) bad.push(at + col + ' «' + v + '» — нужно целое число от 1 или пусто');
    }
    if (!TEAMC_MONTH.test(t.from)) bad.push(at + 'С месяца «' + t.from + '» — нужно ГГГГ-ММ');
    if (!TEAMC_MONTH.test(t.to)) bad.push(at + 'По месяц «' + t.to + '» — нужно ГГГГ-ММ');
    if (TEAMC_MONTH.test(t.from) && TEAMC_MONTH.test(t.to) && t.from > t.to) bad.push(at + 'С месяца ' + t.from + ' позже, чем По месяц ' + t.to);
  });
  rows.stock.forEach((r, i) => {
    const at = 'лист «Остаток», строка ' + (i + 2) + ' (' + (r.store || '?') + ', ' + (r.pos || 'без позиции') + '): ';
    if (!TEAMC_MONTH.test(r.month)) bad.push(at + 'Месяц «' + r.month + '» — нужно ГГГГ-ММ');
    if (!TEAMC_TYPES.includes(r.type)) bad.push(at + 'Тип «' + r.type + '» — нужно «бренд» или «группа»');
    if (r.qty === '' || !Number.isFinite(r.qty)) bad.push(at + 'Штук «' + r.qty + '» — нужно число');
  });
  if (!bad.length) return null;
  return bad.slice(0, 10).join('; ') + (bad.length > 10 ? '; и ещё ' + (bad.length - 10) : '');
}
function teamcRows(data) {
  const num = teamcNum;
  const objs = (part, map) => part.rows.map((row) => {
    const o = {};
    for (const [field, col, isNum] of map) {
      const i = part.header.indexOf(col);
      const v = i >= 0 ? row[i] : '';
      o[field] = isNum ? num(v) : String(v || '').trim();
    }
    return o;
  });
  return {
    thr: objs(data.thresholds, [['pos', 'Позиция'], ['type', 'Тип'], ['four', 'Четвёрка', 1], ['outlet', 'Аутлет', 1],
      ['above', 'Above', 1], ['from', 'С месяца'], ['to', 'По месяц']]),
    stock: objs(data.stock, [['month', 'Месяц'], ['store', 'Магазин'], ['pos', 'Позиция'], ['type', 'Тип'], ['qty', 'Штук', 1]]),
  };
}
async function pullTeamc() {
  const c = teamcConfig();
  if (!c) { console.log('  teamc: источник не настроен — пропускаю'); return null; }
  const url = c.endpoint + '?' + new URLSearchParams({ key: c.key, action: 'teamc' });
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { redirect: 'follow', signal: ac.signal });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'ok:false');
      const p = teamcProblem(j);
      if (p) throw new Error(p);
      const rows = teamcRows(j.data);
      // Ошибка в листе — не сбой связи: повтор её не исправит, останавливаем сборку сразу.
      const bad = teamcRowsProblem(rows);
      if (bad) { const err = new Error('teamc: ошибка в данных конкурса — ' + bad); err.fatal = true; throw err; }
      console.log('  teamc: порогов ' + rows.thr.length + ', строк остатка ' + rows.stock.length);
      return rows;
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      console.log('  попытка ' + attempt + ' из ' + RETRIES + ' не удалась (teamc): ' + e.message);
      if (attempt < RETRIES) await new Promise((res) => setTimeout(res, RETRY_PAUSES_MS[attempt - 1]));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('не удалось получить teamc: ' + lastErr.message);
}

// opts.check(j) — вернуть текст проблемы, и ответ считается неудачной попыткой.
async function askGas(url, payload, label, opts = {}) {
  const doFetch = opts.fetch || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    if (attempt > 1) await sleep(RETRY_PAUSES_MS[attempt - 2]);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await doFetch(url, {
        method: 'POST', redirect: 'follow', signal: ac.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = JSON.parse(await r.text());
      if (!j || j.ok !== true) throw new Error(j && (j.error || j.message) || 'ответ без ok');
      const problem = opts.check && opts.check(j);
      if (problem) throw new Error(problem);
      return j;
    } catch (e) {
      lastErr = e;
      if (!opts.quiet) console.log('  попытка ' + attempt + ' из ' + RETRIES + ' не удалась (' + label + '): ' + e.message);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('не удалось получить ' + label + ': ' + (lastErr && lastErr.message));
}

async function pullAll(urls, code) {
  const want = [
    ['sales', 'SALES', ['meta', 'raw', 'plans']],
    ['staff', 'STAFF', ['meta', 'raw', 'plans']],
    ['empl', 'EMPL', ['meta', 'raw', 'plans']],
    ['finance', 'FINANCE', ['meta', 'summary']],
    ['mkt', 'MKT', ['meta', 'raw']],
  ];
  const data = {};
  for (const [key, urlKey, entities] of want) {
    data[key] = {};
    for (const e of entities) {
      const started = Date.now();
      const j = await askGas(urls[urlKey], { entity: e, accessCode: code, loginName: 'сборка' }, key + '.' + e,
        { check: (a) => answerProblem(key, e, a) });
      data[key][e] = (e === 'meta') ? j : (j.rows || []);
      const n = Array.isArray(data[key][e]) ? data[key][e].length + ' строк' : 'мета';
      console.log('  ' + key + '.' + e + ': ' + n + ', ' + Math.round((Date.now() - started) / 1000) + ' с');
    }
  }
  return data;
}

function sameStore(row, store) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/^магазин\s+/, '').replace(/ё/g, 'е');
  const target = norm(store);
  return norm(row.store) === target || norm(row.shortStore) === target;
}

// Ссылки на отчёты других глав: { loginName: { oldc: url } }. Ссылка на «Старые коллекции»
// (глава 23) у магазина ЛИЧНАЯ — в хвосте «#s=КОД» его код, по нему страница запирается
// на свой магазин. Поэтому она едет только в зашифрованном файле профиля, а не в index.html.
// Источник — секрет OLDC_LINKS: JSON {"логин":"ссылка", …} на КАЖДЫЙ профиль.
const OLDC_HOST = 'https://edigeabdikarim.github.io/oldc-b52e92e0/';
function oldcLinks(raw, logins) {
  let map;
  try { map = JSON.parse(raw || ''); } catch (e) { map = null; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('секрет OLDC_LINKS пуст или не JSON');
  const bad = [];
  const out = {};
  for (const login of logins) {
    const name = login.loginName;
    const url = String(map[name] || '');
    const isStore = normRole(login.role) === 'store';
    if (!url) { bad.push(name + ': нет ссылки'); continue; }
    if (url.indexOf(OLDC_HOST) !== 0) { bad.push(name + ': ссылка не на страницу главы 23'); continue; }
    // Магазин без кода увидел бы «откройте через главу 7»; сеть с кодом — только один магазин.
    if (isStore && !/#s=[A-Za-z0-9_-]{16,128}$/.test(url)) { bad.push(name + ': у магазина в ссылке нет кода #s=…'); continue; }
    if (!isStore && url.indexOf('#') >= 0) { bad.push(name + ': у сети ссылка без кода, а в этой есть «#»'); continue; }
    out[name] = { oldc: url };
  }
  const extra = Object.keys(map).filter((n) => !logins.some((l) => l.loginName === n));
  if (extra.length) bad.push('ссылки для профилей, которых нет: ' + extra.join(', '));
  // Сами ссылки не печатаются: в магазинных лежит код.
  if (bad.length) throw new Error('OLDC_LINKS: ' + bad.join('; '));
  return out;
}

function normRole(role) {
  const r = String(role || 'store').toLowerCase();
  return (r === 'leader' || r === 'admin') ? 'leader' : (r === 'rop' ? 'rop' : 'store');
}

// Конкурс и матрица считаются по всей сети — их данные (staff, empl) нужны каждому,
// включая продавца. Режется только то, что раздел показывает по своему магазину.
function bundleFor(login, data, links) {
  const role = String(login.role || 'store').toLowerCase();
  const isLeader = role === 'leader' || role === 'admin';
  const isNetwork = isLeader || role === 'rop';

  const salesRaw = isNetwork ? data.sales.raw : data.sales.raw.filter((r) => sameStore(r, login.store));
  const salesMeta = isNetwork ? data.sales.meta
    : Object.assign({}, data.sales.meta, { stores: (data.sales.meta.stores || []).filter((s) => sameStore({ store: s }, login.store)) });

  const b = {
    sales: { meta: salesMeta, raw: pack(salesRaw), plans: pack(data.sales.plans) },
    staff: { meta: data.staff.meta, raw: pack(data.staff.raw), plans: pack(data.staff.plans) },
    empl: { meta: data.empl.meta, raw: pack(data.empl.raw), plans: pack(data.empl.plans) },
  };
  if (isLeader) {
    b.finance = { meta: data.finance.meta, summary: pack(data.finance.summary) };
    b.mkt = { meta: data.mkt.meta, raw: pack(data.mkt.raw) };
  }
  if (data.teamc) b.teamc = { thr: pack(data.teamc.thr), stock: pack(data.teamc.stock) };
  if (links) b.links = links[login.loginName];
  return b;
}

function dataThrough(data) {
  const keys = [];
  for (const r of data.sales.raw) { const k = String(r.reportDateKey || '').trim(); if (k.length === 10) keys.push(k); }
  for (const r of data.staff.raw) { const k = String(r.dateKey || '').trim(); if (k.length === 10) keys.push(k); }
  return keys.length ? keys.reduce((m, k) => (k > m ? k : m)) : null;
}

// Имя файла считается из кода доступа, а не из названия магазина. Смысл: не зная кода,
// файл нельзя даже скачать, а значит нельзя и подбирать код у себя на компьютере —
// перебор снова упирается в сеть, как было во времена Apps Script.
// Та же формула в index.html (fileNameFor) — менять только в обоих местах сразу.
const NAME_SALT = 'bugatti-analytics-v8';

async function fileNameFor(login, code) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(NAME_SALT + ':' + login + ':' + code));
  return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('') + '.enc';
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = path.resolve(ROOT, args[args.indexOf('--out') + 1] || 'out');
  const fromDir = args.includes('--from-dir') ? path.resolve(ROOT, args[args.indexOf('--from-dir') + 1]) : null;

  const urls = urlsFromIndexHtml();
  const codes = JSON.parse(process.env.STORE_CODES || '{}');
  const leaderCode = process.env.LEADER_CODE || '';

  let data, logins;
  if (fromDir) {
    console.log('Беру сохранённые выгрузки из ' + fromDir);
    data = JSON.parse(fs.readFileSync(path.join(fromDir, 'data.json'), 'utf8'));
    logins = JSON.parse(fs.readFileSync(path.join(fromDir, 'logins.json'), 'utf8'));
    const teamcFile = path.join(fromDir, 'teamc.json');
    data.teamc = fs.existsSync(teamcFile) ? teamcRows(JSON.parse(fs.readFileSync(teamcFile, 'utf8'))) : null;
  } else {
    if (!leaderCode) throw new Error('нет LEADER_CODE — без него Apps Script не отдаст данные');
    console.log('Забираю список профилей…');
    logins = (await askGas(urls.ACCESS, { entity: 'logins' }, 'logins', { check: loginsProblem })).logins;
    console.log('  профилей: ' + logins.length);
    console.log('Забираю данные (это несколько минут — Apps Script перечитывает листы)…');
    data = await pullAll(urls, leaderCode);
    data.teamc = await pullTeamc();
  }

  const links = oldcLinks(process.env.OLDC_LINKS, logins);

  const through = dataThrough(data);
  if (!through) throw new Error('в данных нет ни одной даты — собирать нечего');
  const meta = {
    builtAt: new Date().toISOString(),
    dataThrough: through,
    rowCounts: { sales: data.sales.raw.length, staff: data.staff.raw.length, empl: data.empl.raw.length },
  };
  console.log('Данные по ' + meta.dataThrough + ': продажи ' + meta.rowCounts.sales +
    ', сотрудники ' + meta.rowCounts.staff + ', продавцы ' + meta.rowCounts.empl);

  const dataOut = path.join(outDir, 'data');
  fs.mkdirSync(dataOut, { recursive: true });

  const index = [];
  const missing = [];
  for (const login of logins) {
    const code = codes[login.loginName];
    if (!code) { missing.push(login.loginName); continue; }
    const body = Object.assign({ meta }, bundleFor(login, data, links));
    const box = await encryptJson(body, code);
    const file = await fileNameFor(login.loginName, code);
    fs.writeFileSync(path.join(dataOut, file), JSON.stringify(box));
    const kb = Math.round(fs.statSync(path.join(dataOut, file)).size / 1024);
    console.log('  ' + login.loginName + ' → ' + kb + ' КБ');
    // Имени файла в списке нет намеренно: дашборд считает его сам из введённого кода.
    index.push({
      loginName: login.loginName, displayName: login.displayName || login.loginName,
      role: login.role, store: login.store || '',
    });
  }

  if (missing.length) {
    throw new Error('для этих профилей нет кода в STORE_CODES: ' + missing.join(', ') +
      '. Добавьте их в секрет — иначе люди останутся без файла.');
  }

  // Последний рубеж: при любом пути сюда пустой список не публикуется — упавшая сборка
  // оставляет на сайте прошлый рабочий набор, а пустой закрыл бы вход всем.
  if (!index.length) throw new Error('профилей 0 — публиковать нечего');

  fs.writeFileSync(path.join(dataOut, 'logins.json'), JSON.stringify({ meta, logins: index }));
  console.log('Готово: ' + index.length + ' файлов в ' + dataOut);
}

if (require.main === module) {
  main().catch((e) => { console.error('СБОРКА НЕ УДАЛАСЬ: ' + e.message); process.exit(1); });
}

module.exports = { askGas, loginsProblem, answerProblem, teamcProblem, teamcRows, teamcRowsProblem, teamcNum, oldcLinks, bundleFor };
