/** 站点 -> host 权限（optional_host_permissions）的申请与检查。 */

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 生成需要申请的 origin 匹配模式 */
export function siteOriginPatterns(site) {
  const s = String(site || '').toLowerCase();
  if (!s) return [];
  if (s.includes(':')) return []; // IPv6：暂不支持动态申请
  if (IPV4_RE.test(s) || !s.includes('.')) return [`*://${s}/*`];
  return [`*://${s}/*`, `*://*.${s}/*`];
}

export async function hasHostPermission(site) {
  const origins = siteOriginPatterns(site);
  if (origins.length === 0) return false;
  return chrome.permissions.contains({ origins });
}

/**
 * 必须在用户手势中「第一时间」调用（前面不要有 await），否则 Chrome 会拒绝弹出授权框。
 */
export async function ensureHostPermission(site) {
  const origins = siteOriginPatterns(site);
  if (origins.length === 0) return false;
  if (await chrome.permissions.contains({ origins })) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch (err) {
    console.warn('[保存账号插件] 申请 host 权限失败', err);
    return false;
  }
}
