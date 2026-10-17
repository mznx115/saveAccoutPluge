import { decryptJson, deriveKey, encryptJson } from '../lib/crypto.js';
import { presentError } from '../lib/errors.js';
import { siteOriginPatterns } from '../lib/host-permission.js';
import {
  isDownloadsSupported, mirrorAll, mirrorSite, readJsonFiles,
} from '../lib/mirror.js';
import { enableEncryption, isUnlocked, lock, removeAccount, unlock } from '../lib/schema.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { fileNameToSite } from '../lib/site.js';
import {
  clearAll, deleteSiteFile, getStorageUsage, listSiteFiles, mergeSiteFile,
  readSiteFile, writeSiteFile,
} from '../lib/store.js';
import { escapeHtml, relativeTime } from '../lib/ui.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  settings: null,
  unlocked: false,
  files: [],
  usage: { bytes: 0, pretty: '0 B' },
  busy: false,
  hostPermissionRows: [],
};

/* ------------------------------- 基础 UI ------------------------------- */

let toastTimer = null;
function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 7000 : 4000);
}

async function run(fn, okMessage) {
  if (state.busy) return;
  state.busy = true;
  document.querySelectorAll('button[data-act]').forEach((b) => { b.disabled = true; });
  try {
    const result = await fn();
    if (okMessage) toast(typeof okMessage === 'function' ? okMessage(result) : okMessage);
  } catch (err) {
    console.error(err);
    toast(presentError(err), 'error');
  } finally {
    state.busy = false;
    await refresh();
  }
}

/* ------------------------------- 刷新状态 ------------------------------- */

async function refresh() {
  state.settings = await getSettings();
  state.unlocked = await isUnlocked();
  state.usage = await getStorageUsage();
  state.files = await listSiteFiles();

  state.hostPermissionRows = await Promise.all(
    state.files.map(async (item) => {
      const origins = siteOriginPatterns(item.site);
      const granted = origins.length > 0
        ? await chrome.permissions.contains({ origins })
        : false;
      return { site: item.site, granted };
    }),
  );

  renderLockBadge();
  renderStorage();
  renderSecurity();
  renderSettings();
  renderAccounts();
}

function renderLockBadge() {
  const el = $('#lockStatus');
  const hasCipher = state.files.some((f) => (f.data?.accounts || []).some((a) => a.secret && !a.secret.plain));
  const encrypted = hasCipher || (state.settings.encryption && Boolean(state.settings.kdfSalt));
  if (!encrypted) {
    el.textContent = '未加密';
    el.className = 'badge';
  } else if (state.unlocked) {
    el.textContent = '已加密 · 已解锁';
    el.className = 'badge on';
  } else {
    el.textContent = '已加密 · 未解锁';
    el.className = 'badge locked';
  }
}

/* ------------------------------- 1. 存储与镜像 ------------------------------- */

function renderStorage() {
  const el = $('#storageBody');
  const total = state.files.reduce((sum, f) => sum + (f.data?.accounts?.length || 0), 0);
  const downloadsOk = isDownloadsSupported();

  el.innerHTML = `
    <div class="row between">
      <div>
        <div>快照保存在<b>插件内部存储</b>：${state.files.length} 个站点、${total} 个账号、占用 ${state.usage.pretty}</div>
        <div class="hint">不需要任何目录授权，浏览器重启后也不会失效。</div>
      </div>
      <div class="row">
        <button data-act="export-all" type="button"${downloadsOk ? '' : ' disabled'}>导出全部到下载文件夹</button>
        <button data-act="show-downloads" type="button"${downloadsOk ? '' : ' disabled'}>打开下载文件夹</button>
      </div>
    </div>

    <label class="inline">
      <input type="checkbox" id="mirrorChk"${state.settings.mirrorEnabled ? ' checked' : ''}>
      <span>每次保存后自动镜像一份 .json 到下载文件夹（一个二级域名一个文件）</span>
    </label>

    <div class="row">
      <label class="field">镜像子文件夹名
        <input id="mirrorDirInput" type="text" value="${escapeHtml(state.settings.mirrorDirName)}" maxlength="60">
      </label>
      <button data-act="save-mirror-dir" type="button">保存</button>
    </div>
    <div class="hint">
      实际路径：<span class="mono">&lt;下载目录&gt;\\${escapeHtml(state.settings.mirrorDirName)}\\&lt;域名&gt;.json</span><br>
      浏览器不允许插件在未授权的情况下写任意目录，所以镜像位置固定为下载目录；插件内部存储才是权威数据，
      下载文件夹里的文件是给你看的备份（可用下面的「导入」再读回来）。
    </div>

    <div class="row">
      <button data-act="import" type="button">从 .json 文件导入</button>
      <button class="danger" data-act="clear-all" type="button">删除全部快照</button>
      <input type="file" id="importInput" accept=".json,application/json" multiple hidden>
    </div>
  `;
}

/* ------------------------------- 2. 加密 ------------------------------- */

function renderSecurity() {
  const el = $('#securityBody');
  const hasCipher = state.files.some((f) => (f.data?.accounts || []).some((a) => a.secret && !a.secret.plain));
  const encryption = hasCipher || (state.settings.encryption && Boolean(state.settings.kdfSalt));

  if (!encryption) {
    el.innerHTML = `
      <div class="warn">当前<b>未加密</b>：快照以明文保存在插件内部存储里。里面的 Cookie 等同于登录凭证，
        建议设置一个口令。设置后所有已保存的快照会立刻被重新加密。</div>
      <div class="row">
        <label class="field">设置口令
          <input id="newPwd" type="password" autocomplete="new-password" placeholder="至少 6 位">
        </label>
        <label class="field">再输一次
          <input id="newPwd2" type="password" autocomplete="new-password">
        </label>
        <button class="primary" data-act="enable-enc" type="button">启用加密</button>
      </div>
      <div class="hint">口令本身不会被保存；忘记口令将无法解密已保存的快照。</div>
    `;
    return;
  }

  if (!state.unlocked) {
    el.innerHTML = `
      <p>快照已加密，输入口令后才能查看和切换账号。</p>
      <div class="row">
        <label class="field">口令
          <input id="unlockPwd" type="password" autocomplete="current-password">
        </label>
        <button class="primary" data-act="unlock" type="button">解锁</button>
      </div>
      <div class="hint">解锁状态只保存在内存里，关闭浏览器后需要重新输入。</div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="ok">已解锁（密钥只缓存在内存中）。</div>
    <div class="row">
      <button data-act="lock" type="button">立即锁定</button>
    </div>
    <details>
      <summary>修改口令（会用新口令重写全部快照）</summary>
      <div class="row" style="margin-top:8px">
        <label class="field">当前口令
          <input id="oldPwd" type="password" autocomplete="current-password">
        </label>
        <label class="field">新口令
          <input id="chgPwd" type="password" autocomplete="new-password">
        </label>
        <label class="field">再输一次
          <input id="chgPwd2" type="password" autocomplete="new-password">
        </label>
        <button class="primary" data-act="change-pwd" type="button">修改口令</button>
      </div>
    </details>
    <details>
      <summary>关闭加密（把全部快照改回明文）</summary>
      <div class="row" style="margin-top:8px">
        <label class="field">当前口令
          <input id="offPwd" type="password" autocomplete="current-password">
        </label>
        <button class="danger" data-act="disable-enc" type="button">确认关闭加密</button>
      </div>
    </details>
  `;
}

/* ------------------------------- 3. 设置 ------------------------------- */

function renderSettings() {
  const el = $('#settingsBody');
  el.innerHTML = `
    <label class="inline">
      <span>账号归组方式</span>
      <select id="granularitySel">
        <option value="etld1"${state.settings.granularity === 'etld1' ? ' selected' : ''}>按二级域名（www.taobao.com 与 detail.taobao.com 共用一个文件）</option>
        <option value="host"${state.settings.granularity === 'host' ? ' selected' : ''}>按完整主机名（每个子域一个文件）</option>
      </select>
    </label>
    <label class="inline">
      <input type="checkbox" id="saveSessionChk"${state.settings.saveSessionStorage ? ' checked' : ''}>
      <span>一起保存 sessionStorage（只在同一个标签页会话内有效）</span>
    </label>
    <label class="inline">
      <input type="checkbox" id="incognitoChk"${state.settings.includeIncognito ? ' checked' : ''}>
      <span>包含隐身窗口的 Cookie</span>
    </label>
    <div class="hint">改动即时生效并只影响之后的保存 / 切换操作。</div>
  `;
}

/* ------------------------------- 4. 账号列表 ------------------------------- */

function renderAccounts() {
  const el = $('#accountsBody');

  if (state.files.length === 0) {
    el.innerHTML = '<div class="hint">还没有任何快照。打开某个网站，点击插件图标即可保存当前账号。</div>';
    return;
  }

  const permissionOf = (site) => state.hostPermissionRows.find((r) => r.site === site)?.granted;

  el.innerHTML = state.files.map((item) => {
    const file = item.data;
    const accounts = file.accounts || [];
    const granted = permissionOf(item.site);
    return `
      <div class="site-block">
        <div class="site-hd">
          <span class="name">${escapeHtml(item.site)}</span>
          <span class="meta">${accounts.length} 个账号 · ${file.isEncrypted ? '已加密' : '明文'} · 更新于 ${relativeTime(file.updatedAt)}</span>
          ${granted ? '' : `<button class="tiny" data-act="grant-host" data-site="${escapeHtml(item.site)}" type="button">授权访问该站</button>`}
          <button class="tiny" data-act="export-one" data-site="${escapeHtml(item.site)}" type="button">导出</button>
          <button class="tiny danger" data-act="delete-file" data-site="${escapeHtml(item.site)}" type="button">删除文件</button>
        </div>
        ${accounts.length === 0
          ? '<ul class="accounts"><li class="hint">空文件</li></ul>'
          : `<ul class="accounts">${accounts.map((a) => `
              <li>
                <span class="acc-label" title="${escapeHtml(a.label)}">${escapeHtml(a.label)}</span>
                <span class="acc-meta">${a.cookieCount ?? 0} cookie · ${a.storageOriginCount ?? 0} origin · ${relativeTime(a.lastUsedAt)}</span>
                <button class="tiny" data-act="rename-account" data-site="${escapeHtml(item.site)}" data-id="${a.id}" type="button">改名</button>
                <button class="tiny danger" data-act="delete-account" data-site="${escapeHtml(item.site)}" data-id="${a.id}" type="button">删除</button>
              </li>`).join('')}</ul>`}
      </div>
    `;
  }).join('');
}

/* ------------------------------- 加密辅助 ------------------------------- */

async function withAllFiles(transform) {
  const sites = [];
  for (const item of state.files) {
    const next = await transform(item.data, item);
    if (next) {
      await writeSiteFile(item.site, next);
      sites.push(item.site);
    }
  }
  return sites;
}

/** 用指定口令解密全部账号负载，返回 Map<site, payload[]> */
async function decryptAllFiles(password, salt, iterations) {
  const key = await deriveKey(password, salt, iterations);
  const map = new Map();
  for (const item of state.files) {
    const payloads = [];
    for (const account of item.data.accounts || []) {
      if (account.secret?.plain) {
        payloads.push(account.secret.plain);
        continue;
      }
      try {
        payloads.push(await decryptJson(key, account.secret));
      } catch {
        throw new Error(`口令不正确，无法解密 ${item.site}`);
      }
    }
    map.set(item.site, payloads);
  }
  return map;
}

/* ------------------------------- 导入 ------------------------------- */

function normalizeImported(data, fileName) {
  if (!data || typeof data !== 'object') throw new Error('不是合法的 JSON 对象');
  if (!Array.isArray(data.accounts)) throw new Error('缺少 accounts 数组，可能不是本插件导出的文件');
  const site = data.site || fileNameToSite(fileName);
  if (!site) throw new Error('无法确定这个文件属于哪个站点');
  return { ...data, site };
}

async function importFiles(fileList) {
  const parsed = await readJsonFiles(fileList);
  const report = { added: 0, skipped: 0, sites: 0, failed: [] };
  const saltMismatch = [];

  for (const entry of parsed) {
    if (entry.error) { report.failed.push(`${entry.fileName}：${entry.error}`); continue; }
    let incoming;
    try {
      incoming = normalizeImported(entry.data, entry.fileName);
    } catch (err) {
      report.failed.push(`${entry.fileName}：${err.message}`);
      continue;
    }

    const existing = await readSiteFile(incoming.site);
    const { file, added, skipped } = mergeSiteFile(existing, incoming);
    await writeSiteFile(incoming.site, file);
    report.added += added;
    report.skipped += skipped;
    report.sites++;
    if (incoming.kdf?.salt && incoming.kdf.salt !== state.settings.kdfSalt) {
      saltMismatch.push(incoming.site);
    }
    if (state.settings.mirrorEnabled) {
      try { await mirrorSite(incoming.site, file, state.settings.mirrorDirName); } catch { /* 忽略 */ }
    }
  }

  if (saltMismatch.length) {
    toast(`注意：${saltMismatch.join('、')} 是用另一个口令加密的，需要那个口令才能读取`, 'error');
  }
  return report;
}

/* ------------------------------- 操作 ------------------------------- */

const actions = {
  async 'export-all'() {
    await run(async () => {
      if (!state.files.length) throw new Error('还没有任何快照');
      const results = await mirrorAll(state.files, state.settings.mirrorDirName);
      const failed = results.filter((r) => !r.ok);
      if (failed.length === results.length) throw new Error(`全部导出失败：${failed[0].error}`);
      return { ok: results.length - failed.length, failed: failed.length };
    }, (r) => (r.failed ? `已导出 ${r.ok} 个文件，${r.failed} 个失败` : `已导出 ${r.ok} 个文件到下载文件夹`));
  },

  async 'export-one'(btn) {
    const site = btn.dataset.site;
    await run(async () => {
      const file = await readSiteFile(site);
      if (!file) throw new Error('快照不存在');
      await mirrorSite(site, file, state.settings.mirrorDirName);
    }, '已导出到下载文件夹');
  },

  async 'show-downloads'() {
    await run(() => chrome.downloads.showDefaultFolder(), null);
  },

  async 'save-mirror-dir'() {
    const name = ($('#mirrorDirInput')?.value || '').trim().replace(/[\\/:*?"<>|]/g, '');
    if (!name) { toast('文件夹名不能为空', 'error'); return; }
    await run(() => setSettings({ mirrorDirName: name }), `镜像文件夹名已改为「${name}」`);
  },

  async import() {
    $('#importInput')?.click();
  },

  async 'clear-all'() {
    if (!window.confirm('确定删除全部快照？此操作不可撤销。')) return;
    await run(async () => {
      const n = await clearAll();
      return n;
    }, (n) => `已删除 ${n} 个站点的快照`);
  },

  async 'grant-host'(btn) {
    const site = btn.dataset.site;
    // 直接请求，中间不做任何 await，避免用户手势失效
    try {
      const ok = await chrome.permissions.request({ origins: siteOriginPatterns(site) });
      toast(ok ? '已授权' : '授权被拒绝', ok ? 'info' : 'error');
    } catch (err) {
      toast(presentError(err), 'error');
    }
    await refresh();
  },

  async 'enable-enc'() {
    const pwd = $('#newPwd')?.value || '';
    const pwd2 = $('#newPwd2')?.value || '';
    if (pwd.length < 6) { toast('口令至少 6 位', 'error'); return; }
    if (pwd !== pwd2) { toast('两次输入的口令不一致', 'error'); return; }

    await run(async () => {
      await enableEncryption(pwd);
      const settings = await getSettings();
      const key = await deriveKey(pwd, settings.kdfSalt, settings.kdfIterations);
      const sites = await withAllFiles(async (file) => {
        const accounts = [];
        for (const account of file.accounts || []) {
          accounts.push({ ...account, secret: await encryptJson(key, account.secret?.plain || {}) });
        }
        return {
          ...file,
          accounts,
          isEncrypted: true,
          kdf: { algo: 'PBKDF2-SHA256', iterations: settings.kdfIterations, salt: settings.kdfSalt },
          updatedAt: new Date().toISOString(),
        };
      });
      return sites.length;
    }, (n) => (n ? `加密已启用，重写了 ${n} 个站点的快照` : '加密已启用'));
  },

  async unlock() {
    const pwd = $('#unlockPwd')?.value || '';
    if (!pwd) { toast('请输入口令', 'error'); return; }
    await run(() => unlock(pwd), '已解锁');
  },
  async lock() {
    await run(() => lock(), '已锁定');
  },

  async 'change-pwd'() {
    const oldPwd = $('#oldPwd')?.value || '';
    const next = $('#chgPwd')?.value || '';
    const next2 = $('#chgPwd2')?.value || '';
    if (next.length < 6) { toast('新口令至少 6 位', 'error'); return; }
    if (next !== next2) { toast('两次输入的新口令不一致', 'error'); return; }

    await run(async () => {
      const before = await getSettings();
      const payloadMap = await decryptAllFiles(oldPwd, before.kdfSalt, before.kdfIterations);
      await enableEncryption(next);
      const after = await getSettings();
      const key = await deriveKey(next, after.kdfSalt, after.kdfIterations);
      const sites = await withAllFiles(async (file) => {
        const payloads = payloadMap.get(file.site) || [];
        const accounts = [];
        for (const [i, account] of (file.accounts || []).entries()) {
          accounts.push({ ...account, secret: await encryptJson(key, payloads[i] || {}) });
        }
        return {
          ...file,
          accounts,
          isEncrypted: true,
          kdf: { algo: 'PBKDF2-SHA256', iterations: after.kdfIterations, salt: after.kdfSalt },
          updatedAt: new Date().toISOString(),
        };
      });
      return sites.length;
    }, (n) => `口令已修改，重写了 ${n} 个站点的快照`);
  },

  async 'disable-enc'() {
    const pwd = $('#offPwd')?.value || '';
    if (!pwd) { toast('请输入当前口令', 'error'); return; }
    await run(async () => {
      const before = await getSettings();
      const payloadMap = await decryptAllFiles(pwd, before.kdfSalt, before.kdfIterations);
      const sites = await withAllFiles(async (file) => {
        const payloads = payloadMap.get(file.site) || [];
        return {
          ...file,
          accounts: (file.accounts || []).map((account, i) => ({
            ...account,
            secret: { plain: payloads[i] || {} },
          })),
          isEncrypted: false,
          kdf: null,
          updatedAt: new Date().toISOString(),
        };
      });
      await setSettings({ encryption: false, keyCheck: null });
      await lock();
      return sites.length;
    }, (n) => `加密已关闭，${n} 个站点的快照已改为明文`);
  },

  async 'rename-account'(btn) {
    const { site, id } = btn.dataset;
    const file = await readSiteFile(site);
    const account = file?.accounts.find((a) => a.id === id);
    if (!account) { toast('账号不存在', 'error'); return; }
    const next = window.prompt('新的账号名称', account.label);
    if (next === null) return;
    const label = next.trim();
    if (!label) { toast('名称不能为空', 'error'); return; }
    await run(async () => {
      account.label = label;
      await writeSiteFile(site, file);
    }, '已改名');
  },

  async 'delete-account'(btn) {
    const { site, id } = btn.dataset;
    await run(async () => {
      const file = await readSiteFile(site);
      if (!file) throw new Error('快照不存在');
      removeAccount(file, id);
      await writeSiteFile(site, file);
      if (state.settings.mirrorEnabled) {
        try { await mirrorSite(site, file, state.settings.mirrorDirName); } catch { /* 忽略 */ }
      }
    }, '账号已删除');
  },

  async 'delete-file'(btn) {
    const site = btn.dataset.site;
    if (!window.confirm(`确定删除 ${site} 的全部账号快照？`)) return;
    await run(() => deleteSiteFile(site), '已删除');
  },
};

/* ------------------------------- 事件绑定 ------------------------------- */

document.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-act]');
  if (!btn) return;
  const fn = actions[btn.dataset.act];
  if (fn) fn(btn);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.id === 'unlockPwd') actions.unlock();
});

document.addEventListener('change', async (event) => {
  const { id } = event.target;
  if (id === 'importInput') {
    const files = event.target.files;
    if (files?.length) {
      await run(() => importFiles(files), (r) => {
        const parts = [`导入 ${r.sites} 个站点，新增 ${r.added} 个账号`];
        if (r.skipped) parts.push(`跳过重复 ${r.skipped} 个`);
        if (r.failed.length) parts.push(`失败：${r.failed.join('；')}`);
        return parts.join('，');
      });
    }
    return;
  }
  if (id === 'granularitySel') await run(() => setSettings({ granularity: event.target.value }), '已保存');
  if (id === 'saveSessionChk') await run(() => setSettings({ saveSessionStorage: event.target.checked }), '已保存');
  if (id === 'incognitoChk') await run(() => setSettings({ includeIncognito: event.target.checked }), '已保存');
  if (id === 'mirrorChk') {
    const on = event.target.checked;
    await run(() => setSettings({ mirrorEnabled: on }), on ? '已开启自动镜像' : '已关闭自动镜像');
  }
});

refresh().catch((err) => {
  console.error(err);
  $('#storageBody').innerHTML = `<div class="warn">初始化失败：${escapeHtml(presentError(err))}</div>`;
});
