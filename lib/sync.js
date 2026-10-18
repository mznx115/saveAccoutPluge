/**
 * 同步编排：**先下载 → 与本地合并 → 再上传**。
 *
 * 合并规则（按站点处理）：
 *   1. 账号按 id 去重，同 id 取 lastUsedAt 更新的那条
 *   2. id 不同但 label 相同的，视为同一账号，同样取较新的（避免两台设备各存一份"主号"）
 *   3. 站点级：两边站点取并集
 *
 * 加密一致性：如果本地与远端都用口令加密，但盐值不同，说明是两套口令，
 * 合并出来的文件会有无法用同一口令解开的账号 —— 这种情况直接拒绝并提示，
 * 不做"看起来成功但实际读不出来"的合并。
 */
import { buildBundle, isBundle } from './bundle.js';
import { mergeSiteFile } from './store.js';
import { downloadBundle, ensureRemoteDir, uploadBundle } from './webdav.js';

/** 同一站点内，把 label 相同但 id 不同的账号合并（保留较新的） */
function dedupeByLabel(file) {
  const groups = new Map();
  const kept = [];
  for (const account of file.accounts || []) {
    if (!account?.label) { kept.push(account); continue; }
    const key = String(account.label).trim();
    const prev = groups.get(key);
    if (!prev) {
      groups.set(key, account);
      kept.push(account);
      continue;
    }
    const newer = new Date(account.lastUsedAt || 0) > new Date(prev.lastUsedAt || 0) ? account : prev;
    const index = kept.indexOf(prev);
    if (newer === account && index >= 0) kept[index] = account;
    groups.set(key, newer);
  }
  file.accounts = kept;
  return file;
}

function saltOf(file) {
  return file?.kdf?.salt || null;
}

function hasCipher(file) {
  return (file?.accounts || []).some((a) => a.secret && !a.secret.plain);
}

/**
 * 检查本地与远端能否安全合并。
 * 返回 null 表示没问题，否则返回错误信息。
 */
export function checkEncryptionCompat(localItems, remoteSites) {
  const localFiles = localItems.map((i) => i.data);
  const remoteFiles = Object.values(remoteSites || {});

  const localEnc = localFiles.filter(hasCipher);
  const remoteEnc = remoteFiles.filter(hasCipher);

  const salts = new Set();
  for (const f of [...localEnc, ...remoteEnc]) {
    const salt = saltOf(f);
    if (salt) salts.add(salt);
  }
  if (salts.size > 1) {
    return '本地与远端的加密口令不一致：无法用同一个口令解开合并后的数据。'
      + '请先在两端统一口令（管理页「加密 → 修改口令」），或关闭其中一端的加密后再同步。';
  }

  // 一侧加密、另一侧有明文账号，也拒绝：混在同一个站点文件里会很难处理
  if (localEnc.length && remoteFiles.some((f) => (f.accounts || []).some((a) => a.secret?.plain))) {
    return '本地已加密，但远端存在明文账号。请先在远端也启用相同口令，或关闭本地加密后再同步。';
  }
  if (remoteEnc.length && localFiles.some((f) => (f.accounts || []).some((a) => a.secret?.plain))) {
    return '远端已加密，但本地存在明文账号。请先在本地也启用相同口令后再同步。';
  }
  return null;
}

/**
 * 把远端 bundle 合并进本地站点列表。
 * @param {Array<{site:string,data:object}>} localItems
 * @param {object|null} remoteBundle
 * @returns {{items: Array, stats: object}}
 */
export function mergeRemoteIntoLocal(localItems, remoteBundle) {
  const bySite = new Map(localItems.map((item) => [item.site, item.data]));
  const stats = {
    remoteSites: 0,
    newSites: 0,
    addedAccounts: 0,
    skippedAccounts: 0,
    replacedOnConflict: 0,
  };

  if (!remoteBundle) return { items: localItems, stats };
  if (!isBundle(remoteBundle)) {
    throw new Error('远端文件不是本插件的备份格式');
  }

  for (const [site, remoteFile] of Object.entries(remoteBundle.sites || {})) {
    if (!Array.isArray(remoteFile?.accounts)) continue;
    stats.remoteSites++;

    const localFile = bySite.get(site);
    if (!localFile) {
      bySite.set(site, dedupeByLabel({ ...remoteFile, site }));
      stats.newSites++;
      stats.addedAccounts += remoteFile.accounts.length;
      continue;
    }

    const { file, added, skipped } = mergeSiteFile(
      dedupeByLabel({ ...localFile, accounts: [...(localFile.accounts || [])] }),
      { ...remoteFile, site },
    );
    bySite.set(site, dedupeByLabel(file));
    stats.addedAccounts += added;
    stats.skippedAccounts += skipped;
  }

  return { items: [...bySite.entries()].map(([site, data]) => ({ site, data })), stats };
}

/**
 * 完整同步流程：下载 → 合并写回本地 → 上传。
 * @param {object} config WebDAV 配置 {url, username, password, dir}
 * @param {object} deps {listSiteFiles, writeSiteFile}
 * @param {(step: string, detail?: object) => void} [onStep]
 */
export async function syncWithWebDav(config, deps, onStep) {
  const { listSiteFiles, writeSiteFile } = deps;
  const report = {
    startedAt: new Date().toISOString(),
    remoteFound: false,
    remoteSites: 0,
    localSitesBefore: 0,
    localSitesAfter: 0,
    newSites: 0,
    addedAccounts: 0,
    skippedAccounts: 0,
    uploadedBytes: 0,
  };

  const localBefore = await listSiteFiles();
  report.localSitesBefore = localBefore.length;

  onStep?.('ensure-dir');
  await ensureRemoteDir(config);

  onStep?.('download');
  const remoteBundle = await downloadBundle(config);
  report.remoteFound = Boolean(remoteBundle);
  report.remoteSites = remoteBundle
    ? Object.keys(remoteBundle.sites || {}).length
    : 0;

  const compatError = checkEncryptionCompat(localBefore, remoteBundle?.sites);
  if (compatError) throw new Error(compatError);

  onStep?.('merge');
  const { items } = mergeRemoteIntoLocal(localBefore, remoteBundle);

  // 只写回真正有变化的站点，减少无谓的存储写入
  const beforeMap = new Map(localBefore.map((i) => [i.site, i.data]));
  for (const item of items) {
    const prev = beforeMap.get(item.site);
    const changed = !prev
      || (prev.updatedAt || '') !== (item.data.updatedAt || '')
      || (prev.accounts?.length || 0) !== (item.data.accounts?.length || 0);
    if (changed) await writeSiteFile(item.site, item.data);
  }
  if (remoteBundle) {
    report.newSites = items.filter((i) => !beforeMap.has(i.site)).length;
    const accountsAfter = items.reduce((n, i) => n + (i.data.accounts?.length || 0), 0);
    const accountsBefore = localBefore.reduce((n, i) => n + (i.data.accounts?.length || 0), 0);
    report.addedAccounts = Math.max(0, accountsAfter - accountsBefore);
  }
  report.localSitesAfter = items.length;

  onStep?.('upload');
  const bundle = buildBundle(items);
  const { bytes } = await uploadBundle(config, bundle);
  report.uploadedBytes = bytes;
  report.finishedAt = new Date().toISOString();
  return report;
}

/**
 * 仅上传：把本地数据直接覆盖到远端，**不下载、不合并**。
 *
 * ⚠️ 破坏性操作：远端原有的、本地没有的账号会被删除。
 * 调用方必须先让用户确认，并建议提示用户"先同步一次再上传"。
 *
 * @param {object} config WebDAV 配置
 * @param {object} deps {listSiteFiles}
 * @param {(step: string) => void} [onStep]
 */
export async function uploadLocalToWebDav(config, deps, onStep) {
  const { listSiteFiles } = deps;

  onStep?.('collect');
  const localItems = await listSiteFiles();
  if (localItems.length === 0) {
    throw new Error('本地没有任何快照，拒绝上传（否则会清空远端备份）');
  }

  onStep?.('ensure-dir');
  await ensureRemoteDir(config);

  onStep?.('upload');
  const bundle = buildBundle(localItems);
  const { bytes } = await uploadBundle(config, bundle);

  return {
    siteCount: bundle.siteCount,
    accountCount: localItems.reduce((n, i) => n + (i.data.accounts?.length || 0), 0),
    uploadedBytes: bytes,
    uploadedAt: new Date().toISOString(),
  };
}
