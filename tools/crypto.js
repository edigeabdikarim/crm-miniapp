// Шифрование пакета данных кодом доступа.
// Тот же алгоритм, что и в браузере (index.html, decryptBundle): WebCrypto есть и в Node,
// и в Chrome, поэтому сборка шифрует, а дашборд расшифровывает без единой библиотеки.

const zlib = require('zlib');

// 100 000 вместо стандартных 200 000: на телефоне продавца вывод ключа занимает
// заметное время, а вход должен быть быстрым. Число итераций едет в самом файле,
// поэтому менять его можно без правок в дашборде.
const ITERATIONS = 100000;

async function deriveKey(code, salt) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function toB64(buf) {
  return Buffer.from(buf).toString('base64');
}

// Сжимаем ДО шифрования: зашифрованное не сжимается ничем — ни здесь, ни по дороге.
// Порядок JSON → gzip → AES-GCM даёт файл втрое-вчетверо легче, а это секунды на телефоне.
async function encryptJson(obj, code) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(code, salt);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'), { level: 9 });
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gz);
  return { v: 2, iter: ITERATIONS, gzip: true, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

async function decryptJson(box, code) {
  const salt = new Uint8Array(Buffer.from(box.salt, 'base64'));
  const iv = new Uint8Array(Buffer.from(box.iv, 'base64'));
  const key = await deriveKey(code, salt);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, key, new Uint8Array(Buffer.from(box.ct, 'base64'))
  );
  const buf = Buffer.from(plain);
  return JSON.parse((box.gzip ? zlib.gunzipSync(buf) : buf).toString('utf8'));
}

module.exports = { encryptJson, decryptJson, ITERATIONS };
