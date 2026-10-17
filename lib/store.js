/**
 * 快照的权威存储：chrome.storage.local。
 *
 * 不再需要用户选目录 / 授权：数据直接存在插件自己的存储里（已申请 unlimitedStorage，
 * 不受 10MB 默认配额限制），下载文件夹里的 .json 只是自动镜像出来的备份。
 *
 * 键名规则：`site:<站点标识>` -> 站点文件对象（结构见 lib/schema.js）
 */
import { migrate } from './schema.js';

const PREFIX = 'site:';

export function storageKeyOf(site) {
  return `${PREFIX}${site}`;
}

export async function readSiteFile(site) {
  const key = storageKeyOf(site);
  const got = await chrome.storage.local.get(key);
  const data = got[key];
  return data ? migrate(structuredClone(data)) : null;
}

export async function writeSiteFile(site, data) {
  await chrome.storage.local.set({ [storageKeyOf(site)]: data });
  return data;
}

export async function deleteSiteFile(site) {
  await chrome.storage.local.remove(storageKeyOf(site));
}

/** 列出所有已保存的站点文件 */
export async function listSiteFiles() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(PREFIX))
    .map(([key, data]) => ({ site: key.slice(PREFIX.length), data }))
    .sort((a, b) => a.site.localeCompare(b.site));
}

export const readAllSiteFiles = listSiteFiles;

export async function getStorageUsage() {
  const bytes = await chrome.storage.local.getBytesInUse(null);
  return { bytes, pretty: formatBytes(bytes) };
}

export async function clearAll() {
  const keys = (await listSiteFiles()).map((item) => storageKeyOf(item.site));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 把一个外部文件（或另一个文件里的数据）合并进来。
 * 账号按 id 去重：新 id 追加，同 id 且更新的替换。
 */
export function mergeSiteFile(existing, incoming) {
  const target = existing
    ? { ...existing, accounts: [...(existing.accounts || [])], hosts: [...(existing.hosts || [])] }
    : {
      schemaVersion: incoming.schemaVersion || 1,
      site: incoming.site,
      hosts: [...(incoming.hosts || [])],
      isEncrypted: false,
      kdf: null,
      updatedAt: new Date().toISOString(),
      accounts: [],
    };

  const byId = new Map(target.accounts.map((a) => [a.id, a]));
  let added = 0;
  let skipped = 0;

  for (const account of incoming.accounts || []) {
    if (!account?.id) continue;
    const prev = byId.get(account.id);
    if (!prev) {
      byId.set(account.id, account);
      added++;
    } else if (new Date(account.lastUsedAt || 0) > new Date(prev.lastUsedAt || 0)) {
      byId.set(account.id, account);
      added++;
    } else {
      skipped++;
    }
  }

  target.accounts = [...byId.values()];
  target.hosts = [...new Set([...target.hosts, ...(incoming.hosts || [])])].sort();
  target.isEncrypted = target.accounts.some((a) => a.secret && !a.secret.plain);
  if (target.isEncrypted && !target.kdf) target.kdf = incoming.kdf || existing?.kdf || null;
  target.updatedAt = new Date().toISOString();
  return { file: target, added, skipped };
}
