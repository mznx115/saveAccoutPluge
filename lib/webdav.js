/**
 * WebDAV 同步（坚果云等）。
 *
 * 同步语义：**远端为主干、本地为并集**
 *   1. 先 GET 远端 bundle（不存在则视为空）
 *   2. 把远端每个站点按账号 id 合并进本地（同 id 取 lastUsedAt 更新的那条）
 *   3. 再把合并后的**全部**本地站点打包 PUT 回远端
 *
 * 这样多台设备之间不会互相覆盖：两边各自新增的账号都会保留下来。
 *
 * ⚠️ 这是整个插件里唯一会联网的模块。tools/check.mjs 对此有白名单检查：
 *    除了本文件，运行时代码中不允许出现 fetch。
 */

const BUNDLE_FILE = 'save-account-plugin.bundle.json';
const TIMEOUT_MS = 30000;

/* ------------------------------- 地址拼接 ------------------------------- */

function trimSlashes(str) {
  return String(str || '').replace(/^\/+|\/+$/g, '');
}

/**
 * 把 base、目录、文件名拼成完整 URL。
 * 每一段单独 encodeURIComponent，避免中文目录名出错。
 */
export function buildDavUrl(baseUrl, dir, fileName) {
  let url = String(baseUrl || '').trim();
  if (!url) throw new Error('服务地址不能为空');
  if (!/^https?:\/\//i.test(url)) throw new Error('服务地址必须以 http:// 或 https:// 开头');
  url = url.replace(/\/+$/, '');

  const dirSeg = trimSlashes(dir)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  if (dirSeg) url += `/${dirSeg}`;

  if (fileName) url += `/${encodeURIComponent(fileName)}`;
  return url;
}

export function bundleUrl(config) {
  return buildDavUrl(config.url, config.dir, BUNDLE_FILE);
}

/* ------------------------------- 鉴权 ------------------------------- */

function basicAuthHeader(username, password) {
  const raw = `${username || ''}:${password || ''}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

/* ------------------------------- 请求 ------------------------------- */

function describeHttpError(status, what) {
  switch (status) {
    case 401:
      return '账号或应用密码不正确（坚果云需要在「安全选项」里生成应用密码，不能直接用登录密码）';
    case 403:
      return '没有权限访问该地址';
    case 404:
      return '远端路径不存在';
    case 405:
      return '服务端不支持该操作';
    case 507:
      return '远端空间不足';
    default:
      return `${what}失败：HTTP ${status}`;
  }
}

async function davRequest(config, { method, url, body, contentType, what }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: basicAuthHeader(config.username, config.password),
        ...(body ? { 'Content-Type': contentType || 'application/octet-stream' } : {}),
      },
      body: body || undefined,
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
    });
    return res;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`${what}超时（${TIMEOUT_MS / 1000} 秒）`);
    throw new Error(`${what}失败：无法连接服务器（${err.message}）`);
  } finally {
    clearTimeout(timer);
  }
}

/** 建立远端目录（已存在则忽略） */
export async function ensureRemoteDir(config) {
  const dirSeg = trimSlashes(config.dir);
  if (!dirSeg) return false;

  // 逐级创建，兼容不支持递归 MKCOL 的服务端
  const parts = dirSeg.split('/').filter(Boolean);
  let built = '';
  for (const part of parts) {
    built = built ? `${built}/${part}` : part;
    const url = buildDavUrl(config.url, built);
    const res = await davRequest(config, { method: 'MKCOL', url, what: '创建目录' });
    // 201 创建成功；405 已存在；409 上级不存在（理论上不会走到）
    if (!res.ok && res.status !== 405 && res.status !== 409) {
      throw new Error(`创建远端目录失败：${describeHttpError(res.status, '创建目录')}`);
    }
  }
  return true;
}

/** 下载远端 bundle；不存在时返回 null */
export async function downloadBundle(config) {
  const url = bundleUrl(config);
  const res = await davRequest(config, { method: 'GET', url, what: '下载远端数据' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(describeHttpError(res.status, '下载远端数据'));

  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`远端文件不是合法 JSON：${err.message}`);
  }
}

/** 上传 bundle */
export async function uploadBundle(config, bundle) {
  const url = bundleUrl(config);
  const body = JSON.stringify(bundle, null, 2);
  const res = await davRequest(config, {
    method: 'PUT',
    url,
    body,
    contentType: 'application/json;charset=utf-8',
    what: '上传数据',
  });
  if (!res.ok) {
    throw new Error(describeHttpError(res.status, '上传数据'));
  }
  return { bytes: new Blob([body]).size };
}

/** 测试连接：只做一次目录探测，不读写数据 */
export async function testConnection(config) {
  const url = buildDavUrl(config.url, config.dir, '');
  const res = await davRequest(config, { method: 'PROPFIND', url, what: '连接测试' });
  // 207 Multi-Status 是 PROPFIND 的正常返回；404 说明地址通但目录还没建
  if (res.ok || res.status === 207) return { ok: true, status: res.status, dirExists: true };
  if (res.status === 404) return { ok: true, status: 404, dirExists: false };
  throw new Error(describeHttpError(res.status, '连接测试'));
}

export const BUNDLE_NAME = BUNDLE_FILE;
