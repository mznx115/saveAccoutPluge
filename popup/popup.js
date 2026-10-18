import { call } from '../lib/bus.js';
import { exportAll, isDownloadsSupported } from '../lib/bundle.js';
import { presentError } from '../lib/errors.js';
import { ensureHostPermission } from '../lib/host-permission.js';
import {
  emptySiteFile, getAccountPayload, isUnlocked, putAccount, removeAccount, unlock,
} from '../lib/schema.js';
import { getSettings, resolveWebDavConfig, setSettings } from '../lib/settings.js';
import { listSiteFiles, readSiteFile, writeSiteFile } from '../lib/store.js';
import { syncWithWebDav } from '../lib/sync.js';
import { escapeHtml, relativeTime } from '../lib/ui.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  settings: null,
  unlocked: false,
  site: null,
  host: '',
  url: '',
  title: '',
  unsupportedReason: '',
  file: null,
  busy: false,
  pendingDelete: null,
};

/* ------------------------------- 小工具 ------------------------------- */

let toastTimer = null;
function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 4000);
}

function banner(text, kind = 'warn') {
  const el = $('#banner');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `banner ${kind === 'warn' ? 'warn' : ''}`;
  el.textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('button[data-act]').forEach((b) => { b.disabled = busy; });
  if (!busy) applyDisabledState();
}

/**
 * 是否需要先解锁。注意判断依据是「文件里真的有密文账号」或「设置里真的启用了加密」，
 * 而不是单看 settings.encryption —— 后者在旧版本里可能是个没有盐值的假 true。
 */
function needsUnlock() {
  if (state.unlocked) return false;
  const hasCipher = (state.file?.accounts || []).some((a) => a.secret && !a.secret.plain);
  return Boolean(state.settings?.encryption && state.settings?.kdfSalt) || hasCipher;
}

/**
 * 保存 / 切换 / 删除 / 导出都需要先解锁；清空只需要 host 权限，所以始终可用。
 * 禁用时必须给出可读的原因，否则用户只会看到"点不了"。
 */
function applyDisabledState() {
  const locked = needsUnlock();
  for (const act of ['save', 'switch', 'delete', 'export']) {
    document.querySelectorAll(`button[data-act="${act}"]`).forEach((b) => {
      b.disabled = locked || state.busy;
    });
  }
  if (locked) {
    banner('快照已加密，请先在上方输入口令解锁后再操作。', 'warn');
  } else {
    banner(null);
  }
}

/* ------------------------------- 数据加载 ------------------------------- */

async function loadFile() {
  if (state.file) return state.file;
  const data = await readSiteFile(state.site);
  state.file = data || emptySiteFile(state.site);
  return state.file;
}

async function init() {
  state.settings = await getSettings();
  state.unlocked = await isUnlocked();

  const info = await call('GET_ACTIVE_SITE').catch(() => null);
  if (info) {
    state.site = info.site;
    state.host = info.host;
    state.url = info.url;
    state.title = info.title;
  } else {
    state.unsupportedReason = '当前页面不是普通网页（chrome:// 或扩展页），无法读取账号数据。';
  }

  if (state.site) {
    try {
      await loadFile();
    } catch (err) {
      toast(presentError(err), 'error');
    }
  }
  render();
}

/* ------------------------------- 渲染 ------------------------------- */

function render() {
  const app = $('#app');
  const labelValue = $('#labelInput')?.value;
  const pwdValue = $('#pwdInput')?.value;

  const badge = $('#lockBadge');
  const hasCipher = (state.file?.accounts || []).some((a) => a.secret && !a.secret.plain);
  if (!hasCipher && !state.settings.encryption) {
    badge.textContent = '未加密';
    badge.className = 'hd-badge';
  } else if (state.unlocked) {
    badge.textContent = '已解锁';
    badge.className = 'hd-badge on';
  } else {
    badge.textContent = '已加密';
    badge.className = 'hd-badge locked';
  }

  if (state.unsupportedReason) {
    app.innerHTML = `<div class="card"><div class="empty">${escapeHtml(state.unsupportedReason)}</div></div>`;
    banner(null);
    return;
  }

  const accounts = state.file?.accounts || [];
  const locked = needsUnlock();

  app.innerHTML = `
    <section class="card">
      <div class="site-name">${escapeHtml(state.site)}</div>
      <div class="site-url" title="${escapeHtml(state.url)}">${escapeHtml(state.url)}</div>
      <div class="site-meta">已保存 ${accounts.length} 个账号 · ${state.settings.granularity === 'host' ? '按完整主机名' : '按二级域名'}归组</div>
    </section>

    ${locked ? `
      <section class="card">
        <div class="card-hd">输入口令解锁</div>
        <label class="field">
          <span>口令</span>
          <input id="pwdInput" type="password" placeholder="用于解密快照" value="${escapeHtml(pwdValue || '')}">
        </label>
        <button class="primary" data-act="unlock" type="button">解锁</button>
      </section>
    ` : ''}

    <section class="card">
      <label class="field">
        <span>保存为</span>
        <input id="labelInput" type="text" maxlength="40"
               value="${escapeHtml(labelValue ?? `账号 ${accounts.length + 1}`)}">
      </label>
      <button class="primary" data-act="save" type="button">保存当前账号</button>
      <div class="row">
        <button class="danger-ghost" data-act="clear" type="button">清空并重新登录</button>
      </div>
    </section>

    <section class="card">
      <div class="card-hd"><span>已保存账号</span><span class="count">${accounts.length}</span></div>
      ${accounts.length === 0
        ? '<div class="empty">这个站点还没有保存过账号</div>'
        : `<ul class="accounts">${accounts.map(renderAccount).join('')}</ul>`}
    </section>
  `;

  applyDisabledState();
  if (state.busy) setBusy(true);
}

function renderAccount(account) {
  const confirming = state.pendingDelete === account.id;
  return `
    <li>
      <div class="acc-main">
        <div class="acc-label" title="${escapeHtml(account.label)}">${escapeHtml(account.label)}</div>
        <div class="acc-sub">${account.cookieCount ?? 0} cookie · 使用于 ${relativeTime(account.lastUsedAt)}</div>
      </div>
      <button class="tiny" data-act="switch" data-id="${account.id}" type="button">切换</button>
      <button class="tiny danger" data-act="delete" data-id="${account.id}" type="button">${confirming ? '确认' : '删除'}</button>
    </li>
  `;
}

/* ------------------------------- 操作 ------------------------------- */

/** 导出全部站点为单个文件（不是每个域名一个文件） */
async function exportEverything() {
  if (!isDownloadsSupported()) {
    toast('当前浏览器不支持 downloads API', 'error');
    return false;
  }
  const items = await listSiteFiles();
  if (!items.length) { toast('还没有保存过任何账号', 'error'); return false; }
  const result = await exportAll(items);
  toast(`已导出 ${result.siteCount} 个站点、${result.accountCount} 个账号到「下载」文件夹：${result.fileName}`);
  return true;
}

/**
 * 关键：chrome.permissions.request 必须在用户手势中尽早调用，
 * 所以这里刻意不做任何 await 前置操作。
 */
async function doSave() {
  if (state.busy) return;
  if (needsUnlock()) { toast('请先在上方输入口令解锁', 'error'); return; }
  const granted = await ensureHostPermission(state.site);
  if (!granted) { toast('未授权访问该站点，无法读取 Cookie', 'error'); return; }

  setBusy(true);
  try {
    const label = ($('#labelInput')?.value || '').trim() || `账号 ${(state.file?.accounts.length || 0) + 1}`;
    const snapshot = await call('COLLECT_SITE', { site: state.site });
    const file = await loadFile();
    await putAccount(file, snapshot, { label });
    await writeSiteFile(state.site, file);
    state.file = file;
    toast(`已保存「${label}」：${snapshot.cookies.length} 个 cookie、${Object.keys(snapshot.webStorage).length} 个 origin`);
    render();
  } catch (err) {
    toast(presentError(err), 'error');
  } finally {
    setBusy(false);
  }
}

async function doClear() {
  if (state.busy) return;
  if (!(await ensureHostPermission(state.site))) { toast('未授权访问该站点', 'error'); return; }
  setBusy(true);
  try {
    const res = await call('CLEAR_SITE', { site: state.site });
    await call('RELOAD_SITE', { site: state.site });
    toast(`已清空：删除 ${res.removed} 个 cookie，清理 ${res.clearedTabs} 个标签页的本地存储。可以登录新账号了。`);
  } catch (err) {
    toast(presentError(err), 'error');
  } finally {
    setBusy(false);
  }
}

async function doSwitch(accountId) {
  if (state.busy) return;
  if (!(await ensureHostPermission(state.site))) { toast('未授权访问该站点', 'error'); return; }

  setBusy(true);
  try {
    const file = await loadFile();
    const account = file.accounts.find((a) => a.id === accountId);
    const payload = await getAccountPayload(file, accountId);
    const result = await call('RESTORE_SITE', { site: state.site, snapshot: payload });
    account.lastUsedAt = new Date().toISOString();
    file.updatedAt = account.lastUsedAt;
    await writeSiteFile(state.site, file);
    state.file = file;
    toast(`已切换到「${account.label}」：写回 ${result.cookies.set}/${result.cookies.total} 个 cookie`
      + (result.mode === 'document_start' ? '，本地存储将在页面加载时恢复' : ''));
    render();
  } catch (err) {
    toast(presentError(err), 'error');
  } finally {
    setBusy(false);
  }
}

async function doDelete(accountId) {
  if (state.pendingDelete !== accountId) {
    state.pendingDelete = accountId;
    render();
    return;
  }
  state.pendingDelete = null;
  setBusy(true);
  try {
    const file = await loadFile();
    removeAccount(file, accountId);
    await writeSiteFile(state.site, file);
    state.file = file;
    toast('已删除该账号快照');
  } catch (err) {
    toast(presentError(err), 'error');
  } finally {
    setBusy(false);
    render();
  }
}

async function doUnlock() {
  const password = $('#pwdInput')?.value || '';
  if (!password) { toast('请输入口令', 'error'); return; }
  setBusy(true);
  try {
    await unlock(password, state.file);
    state.unlocked = true;
    state.file = null;
    await loadFile();
    toast('已解锁');
  } catch (err) {
    toast(presentError(err), 'error');
  } finally {
    setBusy(false);
    render();
  }
}

async function doExport() {
  if (state.busy) return;
  setBusy(true);
  try {
    await exportEverything();
    render();
  } catch (err) {
    toast(presentError(err), 'error');
  } finally {
    setBusy(false);
  }
}

/* ------------------------------- 事件 ------------------------------- */

$('#app').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'save') doSave();
  else if (act === 'clear') doClear();
  else if (act === 'switch') doSwitch(id);
  else if (act === 'delete') doDelete(id);
  else if (act === 'unlock') doUnlock();
  else if (act === 'export') doExport();
});

$('#app').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.id === 'pwdInput') doUnlock();
  if (event.key === 'Enter' && event.target.id === 'labelInput') doSave();
});

$('#openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
$('#openStorage').addEventListener('click', doExport);

/** popup 里的快捷同步：同样先申请权限（此刻在用户手势内） */
$('#davSync').addEventListener('click', async () => {
  if (state.busy) return;
  const url = state.settings?.webdav?.url;
  if (!url || !state.settings.webdav.username) {
    toast('请先在管理页配置 WebDAV 账号', 'error');
    return;
  }
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    toast('WebDAV 地址格式不正确', 'error');
    return;
  }
  const origins = [`${origin}/*`];
  if (!(await chrome.permissions.contains({ origins }))
    && !(await chrome.permissions.request({ origins }))) {
    toast('未授权访问 WebDAV 服务器', 'error');
    return;
  }

  setBusy(true);
  try {
    const config = await resolveWebDavConfig();
    if (!config.password) { toast('请先在管理页填写应用密码', 'error'); return; }
    toast('同步中，请稍候…');
    const report = await syncWithWebDav(config, {
      listSiteFiles,
      writeSiteFile,
    });
    await setSettings({ webdav: { lastSyncAt: new Date().toISOString() } });
    state.file = null;
    await loadFile();
    toast(`同步完成：本地 ${report.localSitesAfter} 个站点`
      + (report.newSites ? `，新增 ${report.newSites} 个` : '')
      + (report.addedAccounts ? `，新增 ${report.addedAccounts} 个账号` : ''));
    render();
  } catch (err) {
    toast(presentError(err), 'error');
  } finally {
    setBusy(false);
  }
});

init().catch((err) => {
  $('#app').innerHTML = `<div class="card"><div class="empty">初始化失败：${escapeHtml(presentError(err))}</div></div>`;
});
