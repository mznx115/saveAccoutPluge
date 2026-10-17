/**
 * 域名归组：把 hostname 归一为「二级域名」（注册域 eTLD+1）。
 *
 * 依赖 lib/vendor/psl-data.js（由 tools/build-psl.mjs 从 publicsuffix.org 生成）。
 * 本模块不触碰任何 chrome.* API，可在 Node 里直接单测。
 */
import { PSL_ICANN, PSL_PRIVATE } from './vendor/psl-data.js';

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

let RULES = null;

function rules() {
  if (RULES) return RULES;
  const exact = new Set();
  const wildcard = new Set();
  const exception = new Set();
  for (const block of [PSL_ICANN, PSL_PRIVATE]) {
    for (const line of block.split('\n')) {
      if (line.length === 0) continue;
      const c = line.charCodeAt(0);
      if (c === 33 /* ! */) exception.add(line.slice(1));
      else if (c === 42 /* * */) wildcard.add(line.slice(2));
      else exact.add(line);
    }
  }
  RULES = { exact, wildcard, exception };
  return RULES;
}

/** 去掉方括号/IPv6 包装、末尾的点、统一小写 */
export function normalizeHost(input) {
  if (!input) return '';
  let host = String(input).trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

export function isIp(host) {
  const h = normalizeHost(host);
  return IPV4_RE.test(h) || h.includes(':');
}

/**
 * 返回公共后缀所占的标签数（默认规则为 1）。
 */
export function publicSuffixLabelCount(hostname) {
  const host = normalizeHost(hostname);
  const labels = host.split('.');
  const { exact, wildcard, exception } = rules();
  let suffixLabels = 1;
  for (let i = 0; i < labels.length; i++) {
    const rest = labels.slice(i).join('.');
    if (exception.has(rest)) {
      suffixLabels = labels.length - i - 1;
      break;
    }
    if (exact.has(rest)) {
      suffixLabels = labels.length - i;
      break;
    }
    if (i < labels.length - 1 && wildcard.has(labels.slice(i + 1).join('.'))) {
      suffixLabels = labels.length - i;
      break;
    }
  }
  return suffixLabels;
}

/**
 * 站点归组。
 * @param {string} hostname 原始 hostname（可含端口以外的任何东西，端口请自行剥掉）
 * @param {'etld1'|'host'} granularity etld1 = 二级域名聚合（默认）；host = 完整主机名
 * @returns {string} 归一后的站点标识，失败返回 ''
 */
export function getSite(hostname, granularity = 'etld1') {
  const host = normalizeHost(hostname);
  if (!host) return '';
  if (granularity === 'host') return host;
  if (isIp(host) || !host.includes('.')) return host;
  const labels = host.split('.');
  const suffixLabels = publicSuffixLabelCount(host);
  if (suffixLabels >= labels.length) return host; // 本身就是一个公共后缀
  return labels.slice(labels.length - suffixLabels - 1).join('.');
}

/** 从 URL 字符串取站点标识；非 http(s) 返回 '' */
export function siteFromUrl(url, granularity = 'etld1') {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  return getSite(u.hostname, granularity);
}

/** 判断某个 URL 是否属于该站点 */
export function urlBelongsToSite(url, site, granularity = 'etld1') {
  const s = siteFromUrl(url, granularity);
  return s !== '' && s === site;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** 站点标识 -> 安全文件名（不带 .json） */
export function siteToFileName(site) {
  let name = normalizeHost(site).replace(/[^a-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!name) name = 'unknown';
  if (WIN_RESERVED.test(name)) name = `_${name}`;
  return name.slice(0, 120);
}

/** 文件名 -> 站点标识 */
export function fileNameToSite(fileName) {
  return String(fileName).replace(/\.json$/i, '');
}
