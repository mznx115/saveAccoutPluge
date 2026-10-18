/** 扩展设置 + 会话级（仅内存）密钥缓存。 */

export const DEFAULTS = Object.freeze({
  /** 'etld1' = 按二级域名聚合；'host' = 完整主机名各一个文件 */
  granularity: 'etld1',
  /**
   * 是否真的加密。默认 false —— 「想加密」不等于「已经加密」：
   * 只有用户设置过口令（生成了 kdfSalt / keyCheck）之后才会变成 true。
   * 早先版本把它默认成 true，导致一上来就是加锁状态却无口令可解，这里必须保持 false。
   */
  encryption: false,
  /** 是否连 sessionStorage 一起保存（默认保存） */
  saveSessionStorage: true,
  /** 是否处理隐身窗口的 cookie（storeId !== '0'） */
  includeIncognito: false,
  /** WebDAV 同步（坚果云等）配置；应用密码不放在这里，见 webdavSecret */
  webdav: Object.freeze({
    url: 'https://dav.jianguoyun.com/dav/',
    username: '',
    dir: 'cockpit-tools',
    enabled: false,
    lastSyncAt: null,
  }),
  kdfSalt: null,
  kdfIterations: 600000,
  /** 加密校验块，用于验证口令是否正确 */
  keyCheck: null,
});

const LOCAL_KEY = 'settings';

/**
 * 修复不一致的历史状态：声称已加密却没有盐值 —— 这种状态下既解不开也没法解锁，
 * 一律按「未加密」处理，用户可以在管理页重新启用。
 */
export function normalizeSettings(settings) {
  if (settings.encryption && !settings.kdfSalt) {
    console.warn('[保存账号插件] 检测到「已加密但没有口令」的残留状态，已按未加密处理');
    return {
      ...settings,
      encryption: false,
      kdfSalt: null,
      kdfIterations: DEFAULTS.kdfIterations,
      keyCheck: null,
    };
  }
  return settings;
}

export async function getSettings() {
  const stored = (await chrome.storage.local.get(LOCAL_KEY))[LOCAL_KEY];
  const merged = normalizeSettings({ ...DEFAULTS, ...(stored || {}) });
  // webdav 是嵌套对象，浅合并会把默认值整个覆盖掉，这里补一次深合并
  merged.webdav = { ...DEFAULTS.webdav, ...(stored?.webdav || {}) };
  // 自愈过的状态顺手写回，避免每次读都重新判断
  if (stored && stored.encryption && !stored.kdfSalt) {
    await chrome.storage.local.set({ [LOCAL_KEY]: merged });
  }
  return merged;
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (patch.webdav) next.webdav = { ...current.webdav, ...patch.webdav };
  await chrome.storage.local.set({ [LOCAL_KEY]: next });
  return next;
}

/* ---------- WebDAV 应用密码（与设置分开存，避免出现在任何导出里） ---------- */

const WEBDAV_SECRET_KEY = 'webdavSecret';

export async function getWebDavPassword() {
  const stored = (await chrome.storage.local.get(WEBDAV_SECRET_KEY))[WEBDAV_SECRET_KEY];
  return stored?.password || '';
}

/** 留空表示保留原密码 */
export async function setWebDavPassword(password) {
  if (password === undefined || password === null || password === '') return false;
  await chrome.storage.local.set({ [WEBDAV_SECRET_KEY]: { password } });
  return true;
}

export async function clearWebDavPassword() {
  await chrome.storage.local.remove(WEBDAV_SECRET_KEY);
}

/** 组成可直接交给 lib/webdav.js 的配置 */
export async function resolveWebDavConfig(overrides = {}) {
  const settings = await getSettings();
  const merged = { ...settings.webdav, ...overrides };
  const password = overrides.password !== undefined && overrides.password !== ''
    ? overrides.password
    : await getWebDavPassword();
  return {
    url: merged.url,
    username: merged.username,
    password,
    dir: merged.dir,
  };
}

/* ---------- 会话级缓存（浏览器关闭即失效，不落盘） ---------- */

export const SESSION = Object.freeze({
  rawKey: 'sessionRawKeyB64',
  saltOfKey: 'sessionKeySalt',
  pendingStorage: 'pendingStorage',
});

export async function getSession(key) {
  const data = await chrome.storage.session.get(key);
  return data[key];
}

export async function setSession(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

export async function removeSession(key) {
  await chrome.storage.session.remove(key);
}

/**
 * 关键：默认 storage.session 只对可信上下文（SW / 扩展页面）开放，
 * content script 读不到。恢复 localStorage 的脚本必须能读到，所以要放开。
 */
export async function allowContentScriptsToReadSession() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch (err) {
    console.warn('[保存账号插件] setAccessLevel 失败（可能 Chrome 版本过低）', err);
  }
}
