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
//
// Коды нигде не печатаются и в собранные файлы не попадают.

const fs = require('fs');
const path = require('path');
const { pack } = require('./pack.js');
const { encryptJson } = require('./crypto.js');

const ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = 120000;
const RETRIES = 3;

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

// opts.check(j) — вернуть текст проблемы, и ответ считается неудачной попыткой.
async function askGas(url, payload, label, opts = {}) {
  const doFetch = opts.fetch || fetch;
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
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
      const j = await askGas(urls[urlKey], { entity: e, accessCode: code, loginName: 'сборка' }, key + '.' + e);
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

// Конкурс и матрица считаются по всей сети — их данные (staff, empl) нужны каждому,
// включая продавца. Режется только то, что раздел показывает по своему магазину.
function bundleFor(login, data) {
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
  } else {
    if (!leaderCode) throw new Error('нет LEADER_CODE — без него Apps Script не отдаст данные');
    console.log('Забираю список профилей…');
    logins = (await askGas(urls.ACCESS, { entity: 'logins' }, 'logins', { check: loginsProblem })).logins;
    console.log('  профилей: ' + logins.length);
    console.log('Забираю данные (это несколько минут — Apps Script перечитывает листы)…');
    data = await pullAll(urls, leaderCode);
  }

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
    const body = Object.assign({ meta }, bundleFor(login, data));
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

module.exports = { askGas, loginsProblem };
