// Экономная запись строк: вместо массива объектов, где в каждой строке повторяются
// названия магазинов, брендов и категорий, — словарь значений и номера.
//
// Распаковка живёт ещё и в index.html (функция unpackRows) — это те же десять строк,
// написанные в стиле файла. Формат менять только в обоих местах сразу.

// Колонка идёт в словарь, если её значения — строки и повторяются достаточно часто.
// Порог 0.5: при большем числе разных значений словарь начинает весить больше выигрыша.
const DICT_RATIO = 0.5;

function pack(rows) {
  rows = rows || [];
  if (!rows.length) return { cols: [], dict: {}, rows: [] };

  const cols = [];
  const seen = Object.create(null);
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen[k]) { seen[k] = true; cols.push(k); }
    }
  }

  const dict = Object.create(null);
  for (const c of cols) {
    let strings = 0, present = 0;
    const uniq = new Set();
    for (const r of rows) {
      const v = r[c];
      if (v === undefined || v === null) continue;
      present++;
      if (typeof v !== 'string') { strings = -1; break; }
      strings++;
      uniq.add(v);
    }
    if (strings > 0 && present > 0 && uniq.size <= present * DICT_RATIO) {
      dict[c] = Array.from(uniq);
    }
  }

  const index = Object.create(null);
  for (const c of Object.keys(dict)) {
    const m = new Map();
    dict[c].forEach((v, i) => m.set(v, i));
    index[c] = m;
  }

  const packed = rows.map((r) => cols.map((c) => {
    const v = r[c];
    // undefined и null различаются: строки без поля вообще и строки с пустой клеткой —
    // разные вещи, и ни то ни другое не должно стать нулём при распаковке.
    if (v === undefined) return null;
    if (v === null) return null;
    if (index[c]) return index[c].get(v);
    return v;
  }));

  return { cols, dict, rows: packed };
}

function unpack(p) {
  if (!p || !p.cols) return [];
  const out = [];
  for (const row of p.rows) {
    const o = {};
    for (let i = 0; i < p.cols.length; i++) {
      const c = p.cols[i];
      const v = row[i];
      o[c] = (p.dict[c] && typeof v === 'number') ? p.dict[c][v] : v;
    }
    out.push(o);
  }
  return out;
}

module.exports = { pack, unpack };
