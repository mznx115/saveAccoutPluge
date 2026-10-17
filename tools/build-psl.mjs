/**
 * 构建脚本：下载 publicsuffix.org 官方公共后缀表，生成 lib/vendor/psl-data.js
 *
 *   node tools/build-psl.mjs
 *
 * 生成物会被提交进仓库；只有需要更新 PSL 时才重新运行本脚本。
 * 运行本脚本需要网络，扩展本身运行时不联网。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../lib/vendor/psl-data.js');
const SOURCE = 'https://publicsuffix.org/list/public_suffix_list.dat';

const res = await fetch(SOURCE, { redirect: 'follow' });
if (!res.ok) throw new Error(`下载 PSL 失败: HTTP ${res.status}`);
const text = await res.text();

const icann = [];
const priv = [];
let section = null;

for (const raw of text.split('\n')) {
  const line = raw.trim();
  if (!line) continue;
  if (line.startsWith('//')) {
    if (line.includes('BEGIN ICANN DOMAINS')) section = icann;
    else if (line.includes('BEGIN PRIVATE DOMAINS')) section = priv;
    continue;
  }
  if (!section) continue;
  section.push(line.toLowerCase());
}

if (icann.length < 5000) throw new Error(`PSL 解析异常，ICANN 规则仅 ${icann.length} 条`);
if (priv.length < 100) throw new Error(`PSL 解析异常，PRIVATE 规则仅 ${priv.length} 条`);

const body = `/**
 * 自动生成，请勿手改 —— 由 tools/build-psl.mjs 生成。
 * 来源: ${SOURCE}
 * 生成时间: ${new Date().toISOString()}
 * ICANN 规则 ${icann.length} 条 / PRIVATE 规则 ${priv.length} 条
 */
export const PSL_ICANN = \`
${icann.join('\n')}
\`;
export const PSL_PRIVATE = \`
${priv.join('\n')}
\`;
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body, 'utf8');
console.log(`OK -> ${OUT}`);
console.log(`  ICANN ${icann.length} 条, PRIVATE ${priv.length} 条, ${(body.length / 1024).toFixed(1)} KB`);
