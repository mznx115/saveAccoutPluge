/**
 * Cookie 采集 / 清空 / 恢复。
 * 只在 Service Worker 或扩展页面中调用（需要 chrome.cookies 权限 + 对应 host 权限）。
 */

/** 由 cookie 反推出一个能匹配到它的 URL，chrome.cookies 的 remove/update 需要它 */
export function cookieToUrl(cookie) {
  const host = String(cookie.domain || '').replace(/^\./, '');
  const scheme = cookie.secure ? 'https' : 'http';
  const path = cookie.path || '/';
  return `${scheme}://${host}${path.startsWith('/') ? path : `/${path}`}`;
}

/** cookie.domain 是否归属于 site（含子域） */
export function cookieBelongsToSite(cookie, site) {
  const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  const s = String(site).toLowerCase();
  return domain === s || domain.endsWith(`.${s}`);
}

/** 字段白名单 + 类型收敛，避免把非法字段塞回 chrome.cookies.set */
function sanitizeCookie(cookie) {
  const out = {
    url: cookieToUrl(cookie),
    name: cookie.name,
    value: cookie.value ?? '',
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (cookie.domain) out.domain = cookie.domain;
  if (typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)) {
    out.expirationDate = cookie.expirationDate;
  }
  if (cookie.sameSite && cookie.sameSite !== 'unspecified') out.sameSite = cookie.sameSite;
  if (cookie.storeId) out.storeId = cookie.storeId;
  if (cookie.partitionKey) out.partitionKey = cookie.partitionKey;
  return out;
}

async function callWithPartitionFallback(fn, details) {
  try {
    return await fn(details);
  } catch (err) {
    if (details.partitionKey) {
      const { partitionKey, ...rest } = details;
      return await fn(rest);
    }
    throw err;
  }
}

/** 采集某个站点下的全部 cookie（含 HttpOnly） */
export async function collectCookies(site, { includeIncognito = false } = {}) {
  const all = await chrome.cookies.getAll({ domain: site });
  return all
    .filter((c) => cookieBelongsToSite(c, site))
    .filter((c) => includeIncognito || !c.storeId || c.storeId === '0')
    .sort((a, b) => (a.domain + a.path + a.name).localeCompare(b.domain + b.path + b.name));
}

/** 清空某个站点下的全部 cookie，返回删除条数 */
export async function clearCookies(site, { includeIncognito = false } = {}) {
  const cookies = await collectCookies(site, { includeIncognito });
  let removed = 0;
  const failed = [];
  for (const cookie of cookies) {
    try {
      await callWithPartitionFallback(
        (d) => chrome.cookies.remove(d),
        { url: cookieToUrl(cookie), name: cookie.name, storeId: cookie.storeId, partitionKey: cookie.partitionKey },
      );
      removed++;
    } catch (err) {
      failed.push({ name: cookie.name, domain: cookie.domain, error: err.message });
    }
  }
  return { removed, total: cookies.length, failed };
}

/** 把快照里的 cookie 写回浏览器 */
export async function restoreCookies(cookies) {
  let set = 0;
  const failed = [];
  for (const cookie of cookies || []) {
    try {
      const details = sanitizeCookie(cookie);
      const result = await callWithPartitionFallback(
        (d) => chrome.cookies.set(d), details,
      );
      if (result) set++;
      else failed.push({ name: cookie.name, domain: cookie.domain, error: '被浏览器拒绝' });
    } catch (err) {
      failed.push({ name: cookie.name, domain: cookie.domain, error: err.message });
    }
  }
  return { set, total: (cookies || []).length, failed };
}
