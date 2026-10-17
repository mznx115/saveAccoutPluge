/**
 * 磁盘镜像与导入导出。
 *
 * 说明：扩展无法在无授权的情况下写任意目录，所以镜像固定落在浏览器的「下载」目录下：
 *   <下载目录>/保存账号插件/taobao.com.json
 * 每次保存都会用 conflictAction: 'overwrite' 覆盖同一个文件，所以仍然是一个二级域名一个文件。
 *
 * ⚠️ URL.createObjectURL 在 Service Worker 里不可用，本模块只能在扩展页面（popup / 管理页）里调用。
 */
import { siteToFileName } from './site.js';

export function mirrorPath(dirName, site) {
  const safeDir = String(dirName || '保存账号插件').replace(/[\\/:*?"<>|]/g, '').trim() || '保存账号插件';
  return `${safeDir}/${siteToFileName(site)}.json`;
}

export function isDownloadsSupported() {
  return typeof chrome !== 'undefined' && Boolean(chrome.downloads?.download);
}

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

/** 把一段文本作为文件下载到 下载目录/<子目录>/<文件名> */
export async function downloadJson(fileName, text) {
  if (!isDownloadsSupported()) throw new Error('当前浏览器不支持 downloads API');
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: fileName,
      conflictAction: 'overwrite', // 覆盖同名文件，避免出现 taobao (1).json
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

/** 把一个站点文件镜像到磁盘 */
export async function mirrorSite(site, data, dirName) {
  return downloadJson(mirrorPath(dirName, site), JSON.stringify(data, null, 2));
}

/** 批量镜像，逐个之间留点间隔，避免浏览器判定为"批量下载"而拦截 */
export async function mirrorAll(items, dirName, onProgress) {
  const results = [];
  for (const [index, item] of items.entries()) {
    try {
      await mirrorSite(item.site, item.data, dirName);
      results.push({ site: item.site, ok: true });
    } catch (err) {
      results.push({ site: item.site, ok: false, error: err.message });
    }
    onProgress?.(index + 1, items.length, item.site);
    if (index < items.length - 1) await new Promise((r) => setTimeout(r, 350));
  }
  return results;
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
