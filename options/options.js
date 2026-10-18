import { decryptJson, deriveKey, encryptJson } from '../lib/crypto.js';
import { exportAll, isDownloadsSupported, normalizeImport, readJsonFiles } from '../lib/bundle.js';
import { presentError } from '../lib/errors.js';
import { siteOriginPatterns } from '../lib/host-permission.js';
import { enableEncryption, isUnlocked, lock, removeAccount, unlock } from '../lib/schema.js';
import {
  getSettings, getWebDavPassword, resolveWebDavConfig, setSettings, setWebDavPassword,
} from '../lib/settings.js';
import {
  clearAll, deleteSiteFile, getStorageUsage, listSiteFiles, mergeSiteFile,
  readSiteFile, writeSiteFile,
} from '../lib/store.js';
import { syncWithWebDav, uploadLocalToWebDav } from '../lib/sync.js';
import { BUNDLE_NAME, testConnection } from '../lib/webdav.js';
import { escapeHtml, relativeTime } from '../lib/ui.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  settings: null,
  unlocked: false,
  webdavPasswordSaved: false,
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
  state.webdavPasswordSaved = Boolean(await getWebDavPassword());
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
  renderWebDav();
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

/* ------------------------------- 1. 存储与导出 ------------------------------- */

function renderStorage() {
  const el = $('#storageBody');
  const total = state.files.reduce((sum, f) => sum + (f.data?.accounts?.length || 0), 0);
  const downloadsOk = isDownloadsSupported();

  el.innerHTML = `
    <div class="row between">
      <div>
        <div>快照保存在<b>插件内部存储</b>：${state.files.length} 个站点、${total} 个账号、占用 ${state.usage.pretty}</div>
        <div class="hint">保存账号时<b>不会</b>下载任何文件；只有你在这里点「导出」才会写文件。</div>
      </div>
      <div class="row">
        <button data-act="export-all" type="button"${downloadsOk ? '' : ' disabled'}>导出全部（单个文件）</button>
        <button data-act="show-downloads" type="button"${downloadsOk ? '' : ' disabled'}>打开下载文件夹</button>
      </div>
    </div>

    <div class="hint">
      导出会把<b>所有域名打包成一个文件</b>，不再是一个域名一个文件：<br>
      <span class="mono">保存账号插件-全部账号-YYYYMMDD-hhmmss.json</span>（落在下载目录）<br>
      导入时选中这个文件即可一次性恢复全部域名，也仍兼容以前导出的单站点 .json。
    </div>

    <div class="row">
      <button class="primary" data-act="import" type="button">导入账号文件</button>
      <button class="danger" data-act="clear-all" type="button">删除全部快照</button>
      <input type="file" id="importInput" accept=".json,application/json" multiple hidden>
    </div>
  `;
}

/* ------------------------------- 2. WebDAV 同步 ------------------------------- */

function renderWebDav() {
  const el = $('#webdavBody');
  const dav = state.settings.webdav || {};
  const hasPwd = Boolean(state.webdavPasswordSaved);
  const fileName = BUNDLE_NAME;

  el.innerHTML = `
    <div class="hint">
      同步到 WebDAV（坚果云等）。同步时会<b>先下载远端 → 与本地合并 → 再上传</b>，
      两台设备各自新增的账号都会保留，不会互相覆盖。
    </div>

    <div class="grid">
      <label class="field grow">
        <span>服务地址</span>
        <input id="davUrl" type="text" placeholder="https://dav.jianguoyun.com/dav/"
               value="${escapeHtml(dav.url || '')}">
      </label>
      <label class="field grow">
        <span>邮箱或用户名（坚果云用账号邮箱）</span>
        <input id="davUser" type="text" autocomplete="username"
               value="${escapeHtml(dav.username || '')}">
      </label>
      <label class="field grow">
        <span>应用密码${hasPwd ? '（已保存，留空则保留）' : ''}</span>
        <input id="davPass" type="password" autocomplete="off"
               placeholder="${hasPwd ? '••••••（留空保持不变）' : '坚果云需使用「应用密码」'}">
      </label>
      <label class="field grow">
        <span>远端目录</span>
        <input id="davDir" type="text" placeholder="save-accout-plugin"
               value="${escapeHtml(dav.dir || '')}">
      </label>
    </div>

    <div class="hint">
      远端文件：<span class="mono">${escapeHtml(dav.dir || '')}/${escapeHtml(fileName)}</span>
      —— 全部域名打包在这一个文件里。<br>
      坚果云需要在「账户信息 → 安全选项」里添加<b>应用密码</b>，直接填登录密码会返回 401。
    </div>

    <div class="row">
      <button data-act="dav-save" type="button">保存配置</button>
      <button data-act="dav-test" type="button">测试连接</button>
      <button class="primary" data-act="dav-sync" type="button">立即同步</button>
      <button class="danger" data-act="dav-upload" type="button">仅上传（覆盖远端）</button>
    </div>

    <div class="hint">
      <b>同步</b>：下载远端 → 与本地合并 → 上传，两边数据都会保留（推荐）。<br>
      <b>仅上传</b>：直接用本地数据覆盖远端，<b>不下载也不合并</b>。远端多出来的账号会被删除，请谨慎使用。
    </div>

    <div class="hint" id="davStatus">
      ${dav.lastSyncAt ? `上次同步：${new Date(dav.lastSyncAt).toLocaleString()}` : '还没有同步过'}
    </div>
  `;
}

/* ------------------------------- 3. 加密 ------------------------------- */

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

async function importFiles(fileList) {
  const parsed = await readJsonFiles(fileList);
  const report = { added: 0, skipped: 0, sites: 0, failed: [] };
  const saltMismatch = [];

  for (const entry of parsed) {
    if (entry.error) { report.failed.push(`${entry.fileName}：${entry.error}`); continue; }

    let entries;
    try {
      entries = normalizeImport(entry.data, entry.fileName);
    } catch (err) {
      report.failed.push(`${entry.fileName}：${err.message}`);
      continue;
    }

    for (const incoming of entries) {
      try {
        const existing = await readSiteFile(incoming.site);
        const { file, added, skipped } = mergeSiteFile(existing, incoming.data);
        await writeSiteFile(incoming.site, file);
        report.added += added;
        report.skipped += skipped;
        report.sites++;
        if (incoming.data.kdf?.salt && incoming.data.kdf.salt !== state.settings.kdfSalt) {
          saltMismatch.push(incoming.site);
        }
      } catch (err) {
        report.failed.push(`${incoming.site}：${presentError(err)}`);
      }
    }
  }

  if (saltMismatch.length) {
    toast(`注意：${saltMismatch.join('、')} 是用另一个口令加密的，需要那个口令才能读取`, 'error');
  }
  return report;
}

/* ------------------------------- 操作 ------------------------------- */

/** 读取 WebDAV 表单当前值（必须是同步的，便于在用户手势中第一时间申请权限） */
function readDavForm() {
  return {
    url: ($('#davUrl')?.value || '').trim() || 'https://dav.jianguoyun.com/dav/',
    username: ($('#davUser')?.value || '').trim(),
    dir: ($('#davDir')?.value || '').trim() || 'save-accout-plugin',
    password: $('#davPass')?.value || '',
  };
}

/**
 * 只申请 WebDAV 服务器这一个域名的访问权限，而不是安装时就申请 "*://*​/*"。
 * 必须在点击事件里尽早调用（前面不要插对网络的 await）。
 */
async function ensureDavPermission(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error('服务地址格式不正确');
  }
  const origins = [`${origin}/*`];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

function setDavStatus(text) {
  const el = $('#davStatus');
  if (el) el.textContent = text;
}

const actions = {
  async 'dav-save'() {
    const url = ($('#davUrl')?.value || '').trim();
    const username = ($('#davUser')?.value || '').trim();
    const dir = ($('#davDir')?.value || '').trim() || 'save-accout-plugin';
    const password = $('#davPass')?.value || '';
    if (!url) { toast('请填写服务地址', 'error'); return; }
    await run(async () => {
      await setSettings({
        webdav: { url, username, dir, enabled: Boolean(username) },
      });
      const saved = await setWebDavPassword(password);
      return saved;
    }, (saved) => (saved ? '配置已保存（含应用密码）' : '配置已保存（应用密码保持不变）'));
  },

  async 'dav-test'() {
    // 先申请权限：此刻仍在用户点击手势内
    const form = readDavForm();
    const granted = await ensureDavPermission(form.url);
    if (!granted) { toast('未授权访问该 WebDAV 地址', 'error'); return; }
    await run(async () => {
      const config = await resolveWebDavConfig(form);
      if (!config.username) throw new Error('请先填写邮箱或用户名');
      if (!config.password) throw new Error('请先填写应用密码');
      return testConnection(config);
    }, (r) => (r.dirExists ? '连接成功，远端目录可用' : '连接成功，但远端目录还不存在（同步时会自动创建）'));
  },

  async 'dav-sync'() {
    if (state.busy) return;
    // 先申请权限：此刻仍在用户点击手势内，任何 await 网络请求都不能插在前面
    const form = readDavForm();
    if (!form.username) { toast('请先填写邮箱或用户名', 'error'); return; }
    const granted = await ensureDavPermission(form.url);
    if (!granted) { toast('未授权访问该 WebDAV 地址', 'error'); return; }

    state.busy = true;
    document.querySelectorAll('button[data-act]').forEach((b) => { b.disabled = true; });
    try {
      await setSettings({ webdav: { url: form.url, username: form.username, dir: form.dir } });
      await setWebDavPassword(form.password);
      const config = await resolveWebDavConfig(form);
      if (!config.password) throw new Error('请先填写应用密码');

      setDavStatus('正在下载远端数据…');
      const report = await syncWithWebDav(config, {
        listSiteFiles,
        writeSiteFile,
      }, (step) => {
        setDavStatus({
          'ensure-dir': '正在检查远端目录…',
          download: '正在下载远端数据…',
          merge: '正在合并本地数据…',
          upload: '正在上传合并结果…',
        }[step] || '同步中…');
      });

      await setSettings({ webdav: { lastSyncAt: new Date().toISOString() } });
      const parts = [
        `同步完成：远端 ${report.remoteSites} 个站点`,
        `本地 ${report.localSitesBefore} → ${report.localSitesAfter} 个站点`,
      ];
      if (report.newSites) parts.push(`新增 ${report.newSites} 个站点`);
      if (report.addedAccounts) parts.push(`新增 ${report.addedAccounts} 个账号`);
      parts.push(`已上传 ${(report.uploadedBytes / 1024).toFixed(1)} KB`);
      toast(parts.join('，'));
    } catch (err) {
      console.error(err);
      toast(presentError(err), 'error');
      setDavStatus(`同步失败：${presentError(err)}`);
    } finally {
      state.busy = false;
      await refresh();
    }
  },

  async 'dav-upload'() {
    if (state.busy) return;
    // 先申请权限：此刻仍在用户点击手势内
    const form = readDavForm();
    if (!form.username) { toast('请先填写邮箱或用户名', 'error'); return; }
    const granted = await ensureDavPermission(form.url);
    if (!granted) { toast('未授权访问该 WebDAV 地址', 'error'); return; }

    // 破坏性操作，必须先确认；文案里明确"会删除远端多出来的账号"
    const ok = window.confirm(
      '「仅上传」会用本地数据【完全覆盖】远端备份。\n\n'
      + '· 不会下载，也不会合并\n'
      + '· 远端有、而本地没有的账号会被删除\n\n'
      + '如果你不确定，请改用「立即同步」。\n\n确定要覆盖远端吗？',
    );
    if (!ok) return;

    state.busy = true;
    document.querySelectorAll('button[data-act]').forEach((b) => { b.disabled = true; });
    try {
      await setSettings({ webdav: { url: form.url, username: form.username, dir: form.dir } });
      await setWebDavPassword(form.password);
      const config = await resolveWebDavConfig(form);
      if (!config.password) throw new Error('请先填写应用密码');

      setDavStatus('正在上传本地数据…');
      const result = await uploadLocalToWebDav(config, { listSiteFiles }, (step) => {
        setDavStatus({
          collect: '正在读取本地数据…',
          'ensure-dir': '正在检查远端目录…',
          upload: '正在覆盖远端数据…',
        }[step] || '上传中…');
      });

      await setSettings({ webdav: { lastSyncAt: new Date().toISOString() } });
      const msg = `已用本地数据覆盖远端：${result.siteCount} 个站点、${result.accountCount} 个账号`
        + `（${(result.uploadedBytes / 1024).toFixed(1)} KB）`;
      toast(msg);
      setDavStatus(msg);
    } catch (err) {
      console.error(err);
      toast(presentError(err), 'error');
      setDavStatus(`上传失败：${presentError(err)}`);
    } finally {
      state.busy = false;
      await refresh();
    }
  },

  async 'export-all'() {
    await run(async () => {
      if (!state.files.length) throw new Error('还没有任何快照');
      return exportAll(state.files);
    }, (r) => `已导出 ${r.siteCount} 个站点、${r.accountCount} 个账号到「下载」文件夹：${r.fileName}`);
  },

  async 'show-downloads'() {
    await run(() => chrome.downloads.showDefaultFolder(), null);
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
});

refresh().catch((err) => {
  console.error(err);
  $('#storageBody').innerHTML = `<div class="warn">初始化失败：${escapeHtml(presentError(err))}</div>`;
});
