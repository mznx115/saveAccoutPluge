/**
 * 账号快照的存取：解锁 / 加锁 / 读写账号条目。
 *
 * 文件结构（磁盘上的 taobao.com.json）：
 * {
 *   schemaVersion, site, hosts, isEncrypted, updatedAt,
 *   kdf: { algo, iterations, salt },
 *   accounts: [
 *     { id, label, note, createdAt, lastUsedAt, hostCount, cookieCount,
 *       secret: { iv, data }              // 加密时
 *       secret: { plain: {cookies, webStorage, sessionStorage} }  // 未加密时
 *     }
 *   ]
 * }
 *
 * 明文部分只保留「站点 + 账号标签 + 时间 + 计数」，敏感的 cookies/storage 全在 secret 里。
 * 这样 popup 在未解锁时也能列出账号名。
 */
import {
  DEFAULT_ITERATIONS, decryptJson, deriveKey, encryptJson, exportKey, importKey, randomBase64,
} from './crypto.js';
import { SESSION, getSession, getSettings, removeSession, setSession, setSettings } from './settings.js';

export const SCHEMA_VERSION = 1;

/** 密钥缓存：salt -> CryptoKey，避免同一个会话里反复跑 PBKDF2 */
const keyCache = new Map();

export function emptySiteFile(site, kdf) {
  return {
    schemaVersion: SCHEMA_VERSION,
    site,
    hosts: [],
    isEncrypted: false,
    updatedAt: new Date().toISOString(),
    kdf: kdf || null,
    accounts: [],
  };
}

export function migrate(file) {
  if (!file || typeof file !== 'object') return null;
  if (!file.accounts) file.accounts = [];
  if (!file.schemaVersion) file.schemaVersion = SCHEMA_VERSION;
  return file;
}

/* ------------------------------- 加锁 / 解锁 ------------------------------- */

/**
 * 用口令解锁。
 * @param {string} password
 * @param {object} [file] 若文件自带 kdf（例如从别的机器导入），优先用文件里的盐值
 */
export async function unlock(password, file = null) {
  const settings = await getSettings();
  const salt = file?.kdf?.salt || settings.kdfSalt;
  if (!salt) {
    // 正常情况下不该走到这里：没设过口令时 encryption 就是 false，界面不会要求解锁
    throw new Error('还没有设置过口令，当前快照是明文保存的。请到管理页「加密」一节设置口令。');
  }
  const iterations = file?.kdf?.iterations || settings.kdfIterations || DEFAULT_ITERATIONS;
  const key = await deriveKey(password, salt, iterations);

  // 用 keyCheck 验证口令是否正确（keyCheck 属于安装级设置，与文件无关）
  if (settings.keyCheck && settings.kdfSalt === salt) {
    try {
      await decryptJson(key, settings.keyCheck);
    } catch {
      throw new Error('口令不正确');
    }
  } else if (!settings.keyCheck) {
    const check = await encryptJson(key, { v: 1, at: new Date().toISOString() });
    await setSettings({ keyCheck: check, kdfSalt: salt, kdfIterations: iterations, encryption: true });
  }

  keyCache.set(salt, key);
  await setSession(SESSION.rawKey, await exportKey(key));
  await setSession(SESSION.saltOfKey, salt);
  return true;
}

export async function lock() {
  keyCache.clear();
  await removeSession(SESSION.rawKey);
  await removeSession(SESSION.saltOfKey);
}

export async function isUnlocked() {
  return Boolean(await getRawKeyBase64());
}
async function getRawKeyBase64() {
  return getSession(SESSION.rawKey);
}

/** 取当前可用于解密的密钥（不触发 PBKDF2） */
async function currentKey() {
  const cached = keyCache.get((await getSession(SESSION.saltOfKey)) || '');
  if (cached) return cached;
  const raw = await getRawKeyBase64();
  if (!raw) return null;
  const key = await importKey(raw);
  keyCache.set((await getSession(SESSION.saltOfKey)) || '', key);
  return key;
}

/**
 * 取得「用于某个文件」的密钥：文件自带的 salt 可能与当前设置不同（导入来的文件），
 * 此时需要用户重新输入该文件的口令。
 */
async function keyForFile(file, password) {
  const settings = await getSettings();
  const salt = file?.kdf?.salt || settings.kdfSalt;
  if (!salt) return null;
  const iterations = file?.kdf?.iterations || settings.kdfIterations || DEFAULT_ITERATIONS;

  const cached = keyCache.get(salt);
  if (cached) return cached;
  if (password) {
    const key = await deriveKey(password, salt, iterations);
    keyCache.set(salt, key);
    return key;
  }
  return currentKey();
}

/** 启用加密：生成 salt 与校验块；调用方需传入当前口令 */
export async function enableEncryption(password) {
  const salt = randomBase64(16);
  const iterations = DEFAULT_ITERATIONS;
  const key = await deriveKey(password, salt, iterations);
  const keyCheck = await encryptJson(key, { v: 1, at: new Date().toISOString() });
  keyCache.set(salt, key);
  await setSettings({ encryption: true, kdfSalt: salt, kdfIterations: iterations, keyCheck });
  await setSession(SESSION.rawKey, await exportKey(key));
  await setSession(SESSION.saltOfKey, salt);
  return true;
}

/* ------------------------------- 账号条目 -------------------------------- */

/** 清掉文件里的加锁态（关闭加密时用） */
export function ensureKdf(file) {
  if (!file.kdf) {
    file.kdf = { algo: 'PBKDF2-SHA256', iterations: DEFAULT_ITERATIONS, salt: null };
  }
  return file.kdf;
}

/**
 * 新建或覆盖一个账号条目。
 * @param {object} file 站点文件
 * @param {object} snapshot {cookies, webStorage, sessionStorage, hosts, origins}
 * @param {object} opts {label, note, overwriteId, password}
 */
export async function putAccount(file, snapshot, opts = {}) {
  const settings = await getSettings();
  const useEncryption = settings.encryption;
  const key = useEncryption ? await keyForFile(file, opts.password) : null;
  if (useEncryption && !key) throw new Error('LOCKED');

  // 文件里已经有口令加密的账号，而当前没有可用口令时，绝不能往同一个文件里塞明文，
  // 否则会出现一半密文一半明文的诡异状态（也容易让人误以为数据没加密）。
  const hasCipher = (file.accounts || []).some((a) => a.secret && !a.secret.plain);
  if (!useEncryption && hasCipher) {
    throw new Error('这个站点已有用口令加密的账号，请先在管理页设置口令并解锁后再保存');
  }

  const payload = {
    cookies: snapshot.cookies || [],
    webStorage: snapshot.webStorage || {},
    sessionStorage: settings.saveSessionStorage ? (snapshot.sessionStorage || {}) : {},
  };

  const secret = useEncryption
    ? await encryptJson(key, payload)
    : { plain: payload };

  const now = new Date().toISOString();
  const meta = {
    label: opts.label || '未命名',
    note: opts.note || '',
    lastUsedAt: now,
    hostCount: (snapshot.hosts || []).length,
    cookieCount: (snapshot.cookies || []).length,
    storageOriginCount: Object.keys(payload.webStorage).length,
  };

  let account;
  const existingIndex = opts.overwriteId
    ? file.accounts.findIndex((a) => a.id === opts.overwriteId)
    : -1;

  if (existingIndex >= 0) {
    account = { ...file.accounts[existingIndex], ...meta, secret };
    file.accounts[existingIndex] = account;
  } else {
    account = { id: crypto.randomUUID(), createdAt: now, ...meta, secret };
    file.accounts.push(account);
  }

  // 以「文件里实际有没有密文账号」为准，而不是以设置为准
  file.isEncrypted = file.accounts.some((a) => a.secret && !a.secret.plain);
  if (useEncryption) {
    file.kdf = {
      algo: 'PBKDF2-SHA256',
      iterations: settings.kdfIterations || DEFAULT_ITERATIONS,
      salt: settings.kdfSalt,
    };
  } else if (!file.isEncrypted) {
    file.kdf = null;
  }
  file.updatedAt = now;
  const hosts = new Set([...(file.hosts || []), ...(snapshot.hosts || [])]);
  file.hosts = [...hosts].sort();
  return account;
}

/** 取账号的敏感负载（需要已解锁 / 传 password） */
export async function getAccountPayload(file, accountId, password) {
  const account = file.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('账号不存在');
  if (account.secret?.plain) return account.secret.plain;

  const key = await keyForFile(file, password);
  if (!key) throw new Error('LOCKED');
  try {
    return await decryptJson(key, account.secret);
  } catch {
    throw new Error('口令不正确或文件已损坏');
  }
}

export function removeAccount(file, accountId) {
  file.accounts = file.accounts.filter((a) => a.id !== accountId);
  file.updatedAt = new Date().toISOString();
  return file;
}
