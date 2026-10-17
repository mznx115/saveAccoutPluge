/**
 * 静态自检：manifest 完整性 / 引用文件是否存在 / import 路径是否可解析 /
 * 代码用到的 chrome.* 命名空间是否都在 manifest 里声明了权限。
 *
 *   node tools/check.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function fail(msg) { problems.push(msg); }
function note(msg) { notes.push(msg); }

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    fail(`JSON 解析失败 ${relative(ROOT, p)}: ${err.message}`);
    return null;
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walk(ROOT);
const relativeAll = allFiles.map((f) => relative(ROOT, f).replace(/\\/g, '/'));

/* ---------------------------- 1. manifest ---------------------------- */
const manifest = readJson(join(ROOT, 'manifest.json'));
if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version 必须是 3');
  if (!manifest.background?.service_worker) fail('缺少 background.service_worker');

  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ].filter(Boolean);

  for (const ref of referenced) {
    if (!existsSync(join(ROOT, ref))) fail(`manifest 引用的文件不存在: ${ref}`);
  }

  const perms = new Set(manifest.permissions || []);
  const expects = ['cookies', 'storage', 'scripting', 'tabs', 'downloads', 'unlimitedStorage'];
  for (const p of expects) {
    if (!perms.has(p)) fail(`manifest 缺少权限: ${p}`);
  }
  if (!manifest.optional_host_permissions?.length) {
    fail('manifest 缺少 optional_host_permissions（需要按站点动态申请）');
  }
  if ((manifest.host_permissions || []).length) {
    fail('不应该写死 host_permissions，会吓退用户；请用 optional_host_permissions');
  }
  if (!manifest.icons || Object.keys(manifest.icons).length === 0) note('manifest 未配置 icons');
}

/* ---------------------------- 2. import 路径 ---------------------------- */
const importRe = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

for (const file of allFiles.filter((f) => ['.js', '.mjs'].includes(extname(f)))) {
  if (file.includes(`${join('', 'vendor')}`) && file.endsWith('psl-data.js')) continue;
  const src = readFileSync(file, 'utf8');
  let m;
  importRe.lastIndex = 0;
  while ((m = importRe.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // 不检查裸模块（本项目零依赖）
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) {
      fail(`import 无法解析: ${relative(ROOT, file)} -> ${spec}`);
    }
  }
}

/* ---------------------------- 3. HTML 引用 ---------------------------- */
for (const file of allFiles.filter((f) => extname(f) === '.html')) {
  const src = readFileSync(file, 'utf8');
  const refs = [...src.matchAll(/(?:src|href)="([^":#]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (!existsSync(resolve(dirname(file), ref))) {
      fail(`HTML 引用的文件不存在: ${relative(ROOT, file)} -> ${ref}`);
    }
  }
}

/* ---------------------------- 4. chrome.* 权限 ---------------------------- */
const NS_PERMISSION = {
  cookies: 'cookies',
  scripting: 'scripting',
  tabs: 'tabs',
  downloads: 'downloads',
  contextMenus: 'contextMenus',
};

const declared = new Set(manifest?.permissions || []);
const usedNamespaces = new Map();

for (const file of allFiles.filter((f) => ['.js', '.mjs'].includes(extname(f)))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bchrome\.([a-zA-Z]+)\./g)) {
    const ns = m[1];
    if (!usedNamespaces.has(ns)) usedNamespaces.set(ns, new Set());
    usedNamespaces.get(ns).add(relative(ROOT, file).replace(/\\/g, '/'));
  }
}

for (const [ns, files] of usedNamespaces) {
  const needed = NS_PERMISSION[ns];
  if (!needed) continue; // runtime / action / permissions / storage.session 等无需声明或已单独校验
  if (!declared.has(needed)) {
    fail(`代码用到 chrome.${ns}.*，但 manifest.permissions 里没有 "${needed}"（用于 ${[...files].join(', ')}）`);
  }
}
if (usedNamespaces.has('storage') && !declared.has('storage')) {
  fail('代码用到 chrome.storage.*，但 manifest.permissions 里没有 "storage"');
}

/* ---------------------------- 5. 动态内容脚本 ---------------------------- */
const bg = readFileSync(join(ROOT, 'background.js'), 'utf8');
for (const m of bg.matchAll(/js:\s*\[([^\]]+)\]/g)) {
  for (const raw of m[1].split(',')) {
    const path = raw.trim().replace(/^['"]|['"]$/g, '');
    if (path && !existsSync(join(ROOT, path))) {
      fail(`background.js 注册的内容脚本不存在: ${path}`);
    }
  }
}
if (!relativeAll.includes('content/restore-at-start.js')) {
  fail('缺少 content/restore-at-start.js');
}

/* ---------------------------- 6. 隐私自检 ---------------------------- */
const netRe = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\b/;
for (const file of allFiles.filter((f) => ['.js', '.mjs'].includes(extname(f)))) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (rel.startsWith('tools/') || rel.startsWith('tests/')) continue;
  const src = readFileSync(file, 'utf8');
  if (netRe.test(src)) {
    fail(`扩展运行时代码里出现网络调用（数据不应外传）: ${rel}`);
  }
}

/* ---------------------------- 输出 ---------------------------- */
console.log(`检查了 ${allFiles.length} 个文件。`);
for (const n of notes) console.log(`  · 提示：${n}`);
if (problems.length === 0) {
  console.log('✓ 静态检查全部通过');
  process.exit(0);
}
console.log(`\n✗ 发现 ${problems.length} 个问题：`);
for (const p of problems) console.log(`  · ${p}`);
process.exit(1);
