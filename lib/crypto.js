/**
 * 口令加密：PBKDF2-SHA256 派生密钥 + AES-GCM 加密。
 * 只用 WebCrypto，零依赖；Service Worker / 扩展页面 / Node 22 都可用。
 *
 * 设计要点：
 *  - salt 是「安装级」的，存在 settings 里（非机密），每个文件里冗余带一份，便于单独迁移；
 *  - 每个账号每次写入都用新的随机 12 字节 IV；
 *  - 派生出的 AES 密钥以 raw 形式缓存在 chrome.storage.session（仅内存），不落盘、不缓存口令本身。
 */
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const DEFAULT_ITERATIONS = 600000;

export function toBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(str) {
  const binary = atob(str);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBase64(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64(bytes);
}

export async function deriveKey(password, saltBase64, iterations = DEFAULT_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromBase64(saltBase64), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true, // extractable：允许导出 raw 以便缓存到 storage.session
    ['encrypt', 'decrypt'],
  );
}

export async function exportKey(key) {
  return toBase64(await crypto.subtle.exportKey('raw', key));
}

export async function importKey(rawBase64) {
  return crypto.subtle.importKey('raw', fromBase64(rawBase64), 'AES-GCM', true, ['encrypt', 'decrypt']);
}

/** 加密任意可 JSON 序列化的值 -> {iv, data}（均为 base64） */
export async function encryptJson(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, textEncoder.encode(JSON.stringify(value)),
  );
  return { iv: toBase64(iv), data: toBase64(cipher) };
}

/** 与 encryptJson 配对；密钥错误会抛异常（AES-GCM 认证失败） */
export async function decryptJson(key, blob) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(blob.iv) }, key, fromBase64(blob.data),
  );
  return JSON.parse(textDecoder.decode(plain));
}
