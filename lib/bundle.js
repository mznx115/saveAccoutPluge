/**
 * 导出与导入。
 *
 * 设计原则：**一个文件装全部域名**。几十个域名也只产生一个 .json，
 * 避免"几十个域名=几十个文件"的搬运噩梦。
 *
 * 导出文件结构（bundle）：
 * {
 *   format: "save-account-plugin.bundle",
 *   schemaVersion: 1,
 *   exportedAt: "...",
 *   sites: { "taobao.com": <站点文件>, "github.com": <站点文件>, ... }
 * }
 *
 * 兼容性：导入时也接受单个站点文件（含 accounts 数组的那种），
 * 这样以前导出的零散文件仍然能读进来。
 *
 * ⚠️ URL.createObjectURL 在 Service Worker 里不可用，本模块只能在扩展页面（popup / 管理页）里调用。
 */

export const BUNDLE_FORMAT = 'save-account-plugin.bundle';
export const BUNDLE_VERSION = 1;

export function isDownloadsSupported() {
  return typeof chrome !== 'undefined' && Boolean(chrome.downloads?.download);
}

/** 导出文件名：带日期，便于区分不同时间点的备份 */
export function bundleFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `保存账号插件-全部账号-${stamp}.json`;
}

/* ------------------------------- 打包 / 拆包 ------------------------------- */

/**
 * 把多个站点文件打成一个 bundle。
 * @param {Array<{site: string, data: object}>} items
 */
export function buildBundle(items) {
  const sites = {};
  for (const item of items) {
    if (!item?.site || !item.data) continue;
    sites[item.site] = item.data;
  }
  return {
    format: BUNDLE_FORMAT,
    schemaVersion: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    siteCount: Object.keys(sites).length,
    sites,
  };
}

/** 是否是一个 bundle（而不是单个站点文件）。必须返回真正的布尔值。 */
export function isBundle(data) {
  return Boolean(data)
    && typeof data === 'object'
    && data.format === BUNDLE_FORMAT
    && Boolean(data.sites)
    && typeof data.sites === 'object'
    && !Array.isArray(data.sites);
}

/**
 * 把任意导入数据规范成 {site, data} 列表。
 * 支持三种输入：bundle、单站点文件（有 accounts）、以及包在 {sites:{...}} 里的宽松格式。
 */
export function normalizeImport(data, fileName = '') {
  if (!data || typeof data !== 'object') {
    throw new Error('不是合法的 JSON 对象');
  }

  if (isBundle(data)) {
    const out = [];
    for (const [site, file] of Object.entries(data.sites)) {
      if (!file || !Array.isArray(file.accounts)) {
        throw new Error(`站点 ${site} 的数据不合法（缺少 accounts）`);
      }
      out.push({ site, data: { ...file, site } });
    }
    if (out.length === 0) throw new Error('这个备份文件里没有站点数据');
    return out;
  }

  // 宽松兼容：{sites: {...}} 但没有 format 标记
  if (data.sites && typeof data.sites === 'object' && !Array.isArray(data.accounts)) {
    const out = [];
    for (const [site, file] of Object.entries(data.sites)) {
      if (!file || !Array.isArray(file.accounts)) continue;
      out.push({ site, data: { ...file, site } });
    }
    if (out.length) return out;
  }

  // 单个站点文件（旧格式）
  if (Array.isArray(data.accounts)) {
    const site = data.site || guessSiteFromFileName(fileName);
    if (!site) throw new Error('无法确定这个文件属于哪个站点（文件里缺少 site 字段）');
    return [{ site, data: { ...data, site } }];
  }

  throw new Error('无法识别的文件格式：既不是全部账号备份，也不是单个站点的快照');
}

function guessSiteFromFileName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim().toLowerCase();
  if (!base) return '';
  // 只接受看起来像域名的（避免把"全部账号"之类的名字当成站点）
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(base) ? base : '';
}

/* ------------------------------- 下载 ------------------------------- */

/** 等一次下载结束（完成 / 中断 / 出错），最多等 timeoutMs */
function waitForDownload(downloadId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { chrome.downloads.onChanged.removeListener(onChanged); } catch { /* ignore */ }
      resolve();
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.error?.current) finish();
      else if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

/** 把一段文本作为文件下载到 下载目录/<文件名> */
export async function downloadText(fileName, text, mime = 'application/json;charset=utf-8') {
  if (!isDownloadsSupported()) throw new Error('当前浏览器不支持 downloads API');
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: fileName,
      conflictAction: 'overwrite',
      saveAs: false,
    });
    // 下载真正读完之后再释放；提前 revoke 会导致文件内容为空
    waitForDownload(downloadId).then(() => setTimeout(() => URL.revokeObjectURL(url), 2000));
    return downloadId;
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/** 导出全部站点为单个文件 */
export async function exportAll(items) {
  const bundle = buildBundle(items);
  if (bundle.siteCount === 0) throw new Error('没有任何快照可以导出');
  const fileName = bundleFileName();
  await downloadText(fileName, JSON.stringify(bundle, null, 2));
  return { fileName, siteCount: bundle.siteCount, accountCount: countAccounts(bundle) };
}

export function countAccounts(bundle) {
  return Object.values(bundle.sites || {})
    .reduce((sum, file) => sum + (file.accounts?.length || 0), 0);
}

/** 读取用户通过 <input type="file"> 选中的 JSON 文件 */
export async function readJsonFiles(fileList) {
  const out = [];
  for (const file of fileList) {
    try {
      const text = await file.text();
      out.push({ fileName: file.name, data: JSON.parse(text) });
    } catch (err) {
      out.push({ fileName: file.name, data: null, error: `解析失败：${err.message}` });
    }
  }
  return out;
}
