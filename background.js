/**
 * Service Worker：只做编排，不碰文件（File System Access 在 SW 里不可用）。
 *
 * 职责：
 *  - cookie 的采集 / 清空 / 写回（chrome.cookies）
 *  - localStorage / sessionStorage 的采集与清空（chrome.scripting 注入）
 *  - 恢复账号时用 document_start 注入（在页面自身 JS 之前写回 storage）
 *  - 右键菜单
 */
import { clearCookies, collectCookies, restoreCookies } from './lib/cookies.js';
import {
  SESSION, allowContentScriptsToReadSession, getSession, getSettings, removeSession, setSession,
} from './lib/settings.js';
import { siteFromUrl, urlBelongsToSite } from './lib/site.js';

const PENDING_MAX_AGE_MS = 5 * 60 * 1000;

const log = (...args) => console.log('[保存账号插件]', ...args);

/* ------------------------------------------------------------------ */
/* 注入函数（会被序列化到页面里执行，不能引用外部变量）                    */
/* ------------------------------------------------------------------ */

function injectedCollect() {
  const dump = (storage) => {
    const out = {};
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        out[key] = storage.getItem(key);
      }
    } catch (err) {
      return { __error: String(err) };
    }
    return out;
  };
  return {
    origin: location.origin,
    local: dump(localStorage),
    session: dump(sessionStorage),
  };
}

function injectedClear() {
  try {
    localStorage.clear();
    sessionStorage.clear();
    return { ok: true, origin: location.origin };
  } catch (err) {
    return { ok: false, origin: location.origin, error: String(err) };
  }
}

function injectedRestore(payload) {
  try {
    for (const [k, v] of Object.entries(payload.local || {})) localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(payload.session || {})) sessionStorage.setItem(k, v);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

async function getGranularity() {
  const settings = await getSettings();
  return settings.granularity || 'etld1';
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function tabsForSite(site) {
  const granularity = await getGranularity();
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.url && urlBelongsToSite(t.url, site, granularity));
}

async function describeActiveSite() {
  const tab = await getActiveTab();
  if (!tab?.url) return { ok: true, data: null };
  const granularity = await getGranularity();
  const site = siteFromUrl(tab.url, granularity);
  if (!site) return { ok: true, data: null, reason: 'unsupported-url', url: tab.url };
  let host = '';
  try {
    host = new URL(tab.url).hostname;
  } catch { /* ignore */ }
  return {
    ok: true,
    data: { site, host, url: tab.url, title: tab.title || '', tabId: tab.id, granularity },
  };
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(value);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/* ------------------------------------------------------------------ */
/* 采集                                                                */
/* ------------------------------------------------------------------ */

async function collectSite(site) {
  const settings = await getSettings();
  const tabs = await tabsForSite(site);

  const cookies = await collectCookies(site, { includeIncognito: settings.includeIncognito });

  const webStorage = {};
  const sessionStorageData = {};
  const origins = new Set();
  const hosts = new Set();
  const skipped = [];

  for (const tab of tabs) {
    let origin;
    try {
      origin = new URL(tab.url).origin;
    } catch {
      continue;
    }
    origins.add(origin);
    hosts.add(new URL(tab.url).hostname);
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectedCollect,
      });
      if (result) {
        if (!result.local?.__error && Object.keys(result.local || {}).length) {
          webStorage[origin] = { ...(webStorage[origin] || {}), ...result.local };
        }
        if (settings.saveSessionStorage
          && !result.session?.__error
          && Object.keys(result.session || {}).length) {
          sessionStorageData[origin] = { ...(sessionStorageData[origin] || {}), ...result.session };
        }
      }
    } catch (err) {
      skipped.push({ url: tab.url, error: err.message });
    }
  }

  // cookie 里出现过的域名也算已知 host
  for (const c of cookies) hosts.add(String(c.domain || '').replace(/^\./, ''));

  return {
    site,
    collectedAt: new Date().toISOString(),
    hosts: [...hosts].filter(Boolean).sort(),
    origins: [...origins].sort(),
    cookies,
    webStorage,
    sessionStorage: sessionStorageData,
    skippedTabs: skipped,
  };
}

/* ------------------------------------------------------------------ */
/* 清空                                                                */
/* ------------------------------------------------------------------ */

async function clearStorageInTabs(site) {
  const tabs = await tabsForSite(site);
  const cleared = [];
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectedClear });
      cleared.push(tab.url);
    } catch (err) {
      log('清空 storage 失败', tab.url, err.message);
    }
  }
  return cleared;
}

async function clearSite(site) {
  const settings = await getSettings();
  const cookieResult = await clearCookies(site, { includeIncognito: settings.includeIncognito });
  const clearedTabs = await clearStorageInTabs(site);
  await clearPending();
  return { ...cookieResult, clearedTabs: clearedTabs.length };
}

/* ------------------------------------------------------------------ */
/* 恢复                                                                */
/* ------------------------------------------------------------------ */

async function readPending() {
  const pending = await getSession(SESSION.pendingStorage);
  if (!pending) return null;
  if (Date.now() - (pending.createdAt || 0) > PENDING_MAX_AGE_MS) {
    await clearPending();
    return null;
  }
  return pending;
}

async function clearPending() {
  const pending = await getSession(SESSION.pendingStorage);
  await removeSession(SESSION.pendingStorage);
  if (pending?.scriptIds?.length) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: pending.scriptIds });
    } catch { /* 可能已经被清掉 */ }
  }
}

function originsToMatches(origins) {
  return origins.map((origin) => `${origin}/*`);
}

/**
 * 把 storage 数据交给「document_start 注入」的通道。
 * 页面还没打开时先写好数据，页面一 navigations 就由 restore-at-start.js 抢先写入。
 */
async function armRestoreScripts(origins, site) {
  const id = `restore-${site.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}`;
  const matches = originsToMatches(origins);
  try {
    await chrome.scripting.registerContentScripts([{
      id,
      matches,
      js: ['content/restore-at-start.js'],
      runAt: 'document_start',
      allFrames: false,
      persistAcrossSessions: false,
    }]);
    return [id];
  } catch (err) {
    log('注册 document_start 脚本失败，将退回「加载后注入 + 刷新」方案', err.message);
    return [];
  }
}

async function restoreSite(site, snapshot, { openIfMissing = true } = {}) {
  const payload = {
    cookies: snapshot.cookies || [],
    webStorage: snapshot.webStorage || {},
    sessionStorage: snapshot.sessionStorage || {},
  };

  // 1) 先把旧状态清干净，避免新旧 session 混用
  await clearCookies(site);
  await clearStorageInTabs(site);

  // 2) 写回 cookie（必须早于页面导航）
  const cookieResult = await restoreCookies(payload.cookies);

  // 3) 组织 storage 恢复数据
  const byOrigin = {};
  for (const [origin, data] of Object.entries(payload.webStorage)) {
    byOrigin[origin] = { ...(byOrigin[origin] || {}), local: data, session: {} };
  }
  for (const [origin, data] of Object.entries(payload.sessionStorage)) {
    byOrigin[origin] = byOrigin[origin] || { local: {}, session: {} };
    byOrigin[origin].session = data;
  }
  const origins = Object.keys(byOrigin);
  if (payload.webStorage && Object.keys(payload.webStorage).length === 0
    && Object.keys(payload.sessionStorage || {}).length === 0) {
    // 没有 storage 要恢复，直接刷新页面即可
    const reloaded = await reloadSite(site);
    return { cookies: cookieResult, storageOrigins: [], reloaded, mode: 'reload-only' };
  }

  if (origins.length === 0) {
    return { cookies: cookieResult, storageOrigins: [], reloaded: 0, mode: 'no-storage' };
  }

  // 4) 装填通道并注册 document_start 脚本
  const scriptIds = await armRestoreScripts(origins, site);
  await setSession(SESSION.pendingStorage, {
    createdAt: Date.now(),
    site,
    byOrigin,
    scriptIds,
  });

  const tabs = await tabsForSite(site);
  if (tabs.length === 0 && openIfMissing) {
    const target = origins.find((o) => o.startsWith('https://')) || origins[0];
    const created = await chrome.tabs.create({ url: `${target}/`, active: true });
    if (scriptIds.length) {
      return { cookies: cookieResult, storageOrigins: origins, openedTabId: created.id, mode: 'document_start' };
    }
    await waitForTabComplete(created.id);
    const fallback = await injectStorageFallback(created.id, byOrigin[target] || { local: {}, session: {} });
    await chrome.tabs.reload(created.id);
    return { cookies: cookieResult, storageOrigins: origins, openedTabId: created.id, mode: 'inject-reload', fallback };
  }

  if (scriptIds.length) {
    const reloaded = await reloadSite(site);
    return { cookies: cookieResult, storageOrigins: origins, reloaded, mode: 'document_start' };
  }

  // 退路：等页面加载完 -> 注入 -> 刷新一次
  let fallbackCount = 0;
  for (const tab of tabs) {
    let origin;
    try {
      origin = new URL(tab.url).origin;
    } catch {
      continue;
    }
    const data = byOrigin[origin];
    if (!data) continue;
    // 已经加载完的标签页不用等，否则会白等 15 秒
    if (tab.status !== 'complete') await waitForTabComplete(tab.id, 15000);
    await injectStorageFallback(tab.id, data);
    fallbackCount++;
  }
  const reloaded = await reloadSite(site);
  return { cookies: cookieResult, storageOrigins: origins, reloaded, mode: 'inject-reload', fallbackCount };
}

async function injectStorageFallback(tabId, data) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedRestore,
      args: [data],
    });
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function reloadSite(site) {
  const tabs = await tabsForSite(site);
  let reloaded = 0;
  for (const tab of tabs) {
    try {
      await chrome.tabs.reload(tab.id);
      reloaded++;
    } catch (err) {
      log('刷新标签页失败', tab.id, err.message);
    }
  }
  return reloaded;
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  await allowContentScriptsToReadSession();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-account',
      title: '保存此站点的账号快照',
      contexts: ['page', 'action'],
    });
  });
});

chrome.runtime.onStartup.addListener(async () => {
  await allowContentScriptsToReadSession();
  await clearPending(); // 上次会话残留的恢复脚本一律清掉
});

allowContentScriptsToReadSession();

// 标签页加载完成后，清掉它已经消费掉的恢复数据
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab?.url) return;
  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return;
  }
  const pending = await readPending();
  if (!pending?.byOrigin?.[origin]) return;
  delete pending.byOrigin[origin];
  if (Object.keys(pending.byOrigin).length === 0) {
    await clearPending();
  } else {
    await setSession(SESSION.pendingStorage, pending);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'save-account') return;
  try {
    await chrome.action.openPopup();
  } catch {
    // 低版本 Chrome 不支持 openPopup，退回管理页
    await chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#save') });
  }
});

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

const handlers = {
  async PING() {
    return { pong: true, at: Date.now() };
  },

  async GET_ACTIVE_SITE() {
    return describeActiveSite();
  },

  async COLLECT_SITE({ site }) {
    if (!site) throw new Error('缺少 site');
    return { ok: true, data: await collectSite(site) };
  },

  async CLEAR_SITE({ site }) {
    if (!site) throw new Error('缺少 site');
    return { ok: true, data: await clearSite(site) };
  },

  async RESTORE_SITE({ site, snapshot, openIfMissing = true }) {
    if (!site || !snapshot) throw new Error('缺少 site 或 snapshot');
    return { ok: true, data: await restoreSite(site, snapshot, { openIfMissing }) };
  },

  async RELOAD_SITE({ site }) {
    return { ok: true, data: { reloaded: await reloadSite(site) } };
  },

  async GET_TABS_FOR_SITE({ site }) {
    const tabs = await tabsForSite(site);
    return { ok: true, data: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })) };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => {
      log('处理消息失败', message?.type, err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    });
  return true; // 异步响应
});
