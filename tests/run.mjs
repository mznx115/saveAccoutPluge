/**
 * 纯逻辑单测（不依赖浏览器）：域名归组 / 文件名 / 加解密 / 快照读写 / 存储层。
 *   node tests/run.mjs
 *
 * 通过一个最小的 chrome API 桩来跑 lib/schema.js 与 lib/store.js
 * （两者都依赖 chrome.storage.local）。
 */

/* ----------------------------- chrome 桩 ----------------------------- */
const memory = { local: {}, session: {} };

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (key === null || key === undefined) return { ...memory.local };
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) out[k] = memory.local[k];
          return out;
        }
        return { [key]: memory.local[key] };
      },
      async set(obj) { Object.assign(memory.local, obj); },
      async remove(keys) { for (const k of [].concat(keys)) delete memory.local[k]; },
      async getBytesInUse() { return JSON.stringify(memory.local).length; },
    },
    session: {
      async get(key) { return { [key]: memory.session[key] }; },
      async set(obj) { Object.assign(memory.session, obj); },
      async remove(key) { delete memory.session[key]; },
      async setAccessLevel() { /* noop */ },
    },
  },
};

const { getSite, siteFromUrl, siteToFileName, fileNameToSite, isIp } = await import('../lib/site.js');
const { encryptJson, decryptJson, deriveKey, randomBase64, toBase64, fromBase64 } = await import('../lib/crypto.js');
const { cookieToUrl, cookieBelongsToSite } = await import('../lib/cookies.js');
const {
  emptySiteFile, enableEncryption, putAccount, getAccountPayload, removeAccount, lock,
} = await import('../lib/schema.js');
const { getSettings, normalizeSettings } = await import('../lib/settings.js');
const { isUnlocked, unlock } = await import('../lib/schema.js');
const {
  storageKeyOf, readSiteFile, writeSiteFile, deleteSiteFile, listSiteFiles, getStorageUsage,
  clearAll, mergeSiteFile,
} = await import('../lib/store.js');
const { mirrorPath } = await import('../lib/mirror.js');

/* ----------------------------- 迷你测试框架 ----------------------------- */
let passed = 0;
const failures = [];
let currentGroup = '';

function group(name) { currentGroup = name; console.log(`\n── ${name} ──`); }

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${currentGroup} / ${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
    console.log(`  ✗ ${label}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

async function checkRejects(label, promise, messagePart) {
  try {
    await promise;
    failures.push(`${currentGroup} / ${label}: 没有抛异常`);
    console.log(`  ✗ ${label}（本应抛异常）`);
  } catch (err) {
    if (messagePart && !String(err.message).includes(messagePart)) {
      failures.push(`${currentGroup} / ${label}: 异常信息不含「${messagePart}」，实际「${err.message}」`);
      console.log(`  ✗ ${label}（异常信息不符：${err.message}）`);
    } else {
      passed++;
      console.log(`  ✓ ${label}`);
    }
  }
}

/* ----------------------------- 1. 域名归组 ----------------------------- */
group('域名归组（二级域名 eTLD+1）');
check('www.taobao.com -> taobao.com', getSite('www.taobao.com'), 'taobao.com');
check('detail.taobao.com -> taobao.com', getSite('detail.taobao.com'), 'taobao.com');
check('TAOBAO.COM 大小写归一', getSite('WWW.Taobao.COM'), 'taobao.com');
check('末尾点归一', getSite('www.taobao.com.'), 'taobao.com');
check('a.b.co.uk -> b.co.uk', getSite('a.b.co.uk'), 'b.co.uk');
check('co.uk 本身是公共后缀', getSite('co.uk'), 'co.uk');
check('www.baidu.com.cn -> baidu.com.cn', getSite('www.baidu.com.cn'), 'baidu.com.cn');
check('foo.github.io -> foo.github.io（私有后缀）', getSite('foo.github.io'), 'foo.github.io');
check('a.b.ck 通配规则 *.ck', getSite('a.b.ck'), 'a.b.ck');
check('www.ck 例外规则 !www.ck', getSite('www.ck'), 'www.ck');
check('foo.s3.amazonaws.com 多段私有后缀', getSite('foo.s3.amazonaws.com'), 'foo.s3.amazonaws.com');
check('localhost', getSite('localhost'), 'localhost');
check('127.0.0.1', getSite('127.0.0.1'), '127.0.0.1');
check('IPv6 ::1', getSite('::1'), '::1');
check('host 粒度保留完整主机名', getSite('www.taobao.com', 'host'), 'www.taobao.com');
check('空输入', getSite(''), '');

group('从 URL 解析站点');
check('https 正常', siteFromUrl('https://item.taobao.com/x?y=1'), 'taobao.com');
check('http 正常', siteFromUrl('http://www.example.com/'), 'example.com');
check('chrome:// 不支持', siteFromUrl('chrome://extensions'), '');
check('file:// 不支持', siteFromUrl('file:///C:/a.html'), '');
check('非法 URL', siteFromUrl('not a url'), '');

group('IP 判定');
check('127.0.0.1 是 IP', isIp('127.0.0.1'), true);
check('::1 是 IP', isIp('::1'), true);
check('taobao.com 不是 IP', isIp('taobao.com'), false);

group('文件名映射');
check('普通域名', siteToFileName('taobao.com'), 'taobao.com');
check('冒号替换（IPv6）', siteToFileName('::1'), '__1');
check('Windows 保留名加前缀', siteToFileName('con'), '_con');
check('文件名回推站点', fileNameToSite('taobao.com.json'), 'taobao.com');

group('镜像路径');
check('默认子目录', mirrorPath('保存账号插件', 'taobao.com'), '保存账号插件/taobao.com.json');
check('非法字符被清理', mirrorPath('a/b:c', 'taobao.com'), 'abc/taobao.com.json');
check('空目录名有兜底', mirrorPath('', 'taobao.com'), '保存账号插件/taobao.com.json');

/* ----------------------------- 2. 编码 ----------------------------- */
group('base64 往返');
const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
check('bytes -> base64 -> bytes', [...fromBase64(toBase64(bytes))], [...bytes]);
check('随机 16 字节长度', fromBase64(randomBase64(16)).length, 16);

/* ----------------------------- 3. cookie 工具 ----------------------------- */
group('cookie -> URL');
check('域名 cookie 去前导点', cookieToUrl({ domain: '.taobao.com', path: '/', secure: true }), 'https://taobao.com/');
check('http + 子路径', cookieToUrl({ domain: 'www.a.com', path: '/x', secure: false }), 'http://www.a.com/x');
check('归属判定：子域', cookieBelongsToSite({ domain: '.taobao.com' }, 'taobao.com'), true);
check('归属判定：无关域', cookieBelongsToSite({ domain: '.tmall.com' }, 'taobao.com'), false);
check('归属判定：后缀不算（evitaobao.com）', cookieBelongsToSite({ domain: '.evitaobao.com' }, 'taobao.com'), false);

/* ----------------------------- 4. 加解密 ----------------------------- */
group('AES-GCM 加解密');
const key = await deriveKey('correct horse battery staple', randomBase64(16), 10000);
const secret = { cookies: [{ name: 'SESSION', value: 'abc' }], webStorage: { 'https://a.com': { t: '1' } } };
const blob = await encryptJson(key, secret);
check('密文不含明文', JSON.stringify(blob).includes('SESSION'), false);
check('往返一致', await decryptJson(key, blob), secret);
const otherKey = await deriveKey('wrong password', randomBase64(16), 10000);
await checkRejects('错误口令解密失败', decryptJson(otherKey, blob), '');
const blob2 = await encryptJson(key, secret);
check('同一明文两次加密 IV 不同', blob.iv !== blob2.iv, true);

/* ----------------------------- 5. 默认状态 ----------------------------- */
group('默认状态（回归：不应一上来就加锁）');
// 清空所有存储，模拟全新安装
for (const k of Object.keys(memory.local)) delete memory.local[k];
for (const k of Object.keys(memory.session)) delete memory.session[k];

/** 全篇共用的样例快照 */
const snapshot = {
  site: 'taobao.com',
  hosts: ['www.taobao.com', '.taobao.com'],
  cookies: [{ name: 'SESSION', value: 'secret-value', domain: '.taobao.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }],
  webStorage: { 'https://www.taobao.com': { token: 'T1' } },
  sessionStorage: { 'https://www.taobao.com': { tmp: 'S1' } },
};

const fresh = await getSettings();
check('全新安装默认不加密', fresh.encryption, false);
check('全新安装没有盐值', fresh.kdfSalt, null);
check('全新安装不是解锁态', await isUnlocked(), false);
check('默认按二级域名归组', fresh.granularity, 'etld1');
check('默认没有自动下载开关（保存不写文件）', 'mirrorEnabled' in fresh, false);

// 旧版本残留的脏状态：声称已加密但没有盐值
const dirty = normalizeSettings({ ...fresh, encryption: true, kdfSalt: null });
check('脏状态被自愈为未加密', dirty.encryption, false);
check('自愈后盐值为空', dirty.kdfSalt, null);

const dirtyWithSalt = normalizeSettings({ ...fresh, encryption: true, kdfSalt: 'abc' });
check('有盐值的加密状态不被改动', dirtyWithSalt.encryption, true);

// 未设置口令时保存：应该是明文，且不报错
const plainFile = emptySiteFile('plain.com');
const plainAccount = await putAccount(plainFile, snapshot, { label: '明文号' });
check('未加密时保存成功', plainFile.accounts.length, 1);
check('未加密时文件标记为明文', plainFile.isEncrypted, false);
check('未加密时明文可直接读', plainAccount.secret.plain.cookies[0].value, 'secret-value');
check('明文快照可读回', (await getAccountPayload(plainFile, plainAccount.id)).cookies[0].value, 'secret-value');

// 明文文件里已有密文账号时，不允许再写明文
const mixedFile = {
  ...emptySiteFile('mixed.com'),
  accounts: [{ id: 'x', label: '密文号', secret: { iv: 'a', data: 'b' } }],
};
let mixedError = null;
try {
  await putAccount(mixedFile, snapshot, { label: '明文号' });
} catch (err) {
  mixedError = err.message;
}
check('拒绝往加密文件里写明文', Boolean(mixedError && mixedError.includes('口令加密')), true);

/* ----------------------------- 6. 快照内容 ----------------------------- */
group('快照文件：加密写入与读回');
await enableEncryption('test-passphrase');
const settings = await getSettings();
check('加密已开启', settings.encryption, true);
check('已生成盐值', typeof settings.kdfSalt === 'string' && settings.kdfSalt.length > 0, true);

const file = emptySiteFile('taobao.com');

const account = await putAccount(file, snapshot, { label: '主号' });
check('账号已写入', file.accounts.length, 1);
check('标记为已加密', file.isEncrypted, true);
check('文件里没有明文 cookie 值', JSON.stringify(file).includes('secret-value'), false);
check('明文元数据保留标签', account.label, '主号');
check('cookie 计数', account.cookieCount, 1);
check('hosts 合并去重', file.hosts.length, 2);

const payload = await getAccountPayload(file, account.id);
check('解密后 cookie 完整', payload.cookies[0].value, 'secret-value');
check('解密后 localStorage 完整', payload.webStorage['https://www.taobao.com'].token, 'T1');
check('解密后 sessionStorage 完整', payload.sessionStorage['https://www.taobao.com'].tmp, 'S1');

group('快照文件：多账号与覆盖');
const account2 = await putAccount(file, { ...snapshot, cookies: [] }, { label: '小号' });
check('第二个账号', file.accounts.length, 2);
check('两个账号 id 不同', account.id !== account2.id, true);
await putAccount(file, snapshot, { label: '小号改名', overwriteId: account2.id });
check('覆盖不新增', file.accounts.length, 2);
check('覆盖后标签更新', file.accounts[1].label, '小号改名');

group('快照文件：锁定后拒绝写入');
await lock();
const lockedFile = emptySiteFile('example.com');
let lockedError = null;
try {
  await putAccount(lockedFile, snapshot, { label: 'x' });
} catch (err) {
  lockedError = err.message;
}
check('锁定后写入被拒绝', lockedError, 'LOCKED');

group('快照文件：删除账号');
await enableEncryption('test-passphrase');
removeAccount(file, account.id);
check('删除后剩 1 个', file.accounts.length, 1);
check('剩下的是小号改名', file.accounts[0].label, '小号改名');

/* ----------------------------- 6. 存储层 ----------------------------- */
group('存储层（chrome.storage.local）');
check('键名前缀', storageKeyOf('taobao.com'), 'site:taobao.com');
check('未保存过的站点返回 null', await readSiteFile('never-saved.com'), null);

await writeSiteFile('github.com', { ...file, site: 'github.com' });
const readBack = await readSiteFile('github.com');
check('写入后可读回', readBack.site, 'github.com');
check('读回的是副本（改它不影响存储）', (() => {
  readBack.accounts.push({ id: 'ghost' });
  return memory.local['site:github.com'].accounts.length;
})(), 1);

const listed = await listSiteFiles();
check('列表只包含站点键', listed.some((x) => x.site === 'settings'), false);
check('列表包含刚写入的站点', listed.map((x) => x.site), ['github.com']);

const usage = await getStorageUsage();
check('占用统计是数字', typeof usage.bytes === 'number' && usage.bytes > 0, true);

await deleteSiteFile('github.com');
check('删除后读回 null', await readSiteFile('github.com'), null);
check('删除后列表为空', (await listSiteFiles()).length, 0);

group('导入合并');
const base = { ...file, site: 'a.com', accounts: [{ id: '1', label: '旧的', lastUsedAt: '2024-01-01T00:00:00Z' }] };
const incoming = {
  site: 'a.com',
  accounts: [
    { id: '1', label: '新的', lastUsedAt: '2025-01-01T00:00:00Z' },
    { id: '2', label: '另一个', lastUsedAt: '2025-01-01T00:00:00Z' },
  ],
  hosts: ['www.a.com'],
};
const merged = mergeSiteFile(base, incoming);
check('新增 2 个（同 id 取更新的一条）', merged.added, 2);
check('合并后共 2 个账号', merged.file.accounts.length, 2);
check('同 id 被更新', merged.file.accounts.find((a) => a.id === '1').label, '新的');
check('hosts 合并', merged.file.hosts.includes('www.a.com'), true);

const mergedAgain = mergeSiteFile(merged.file, {
  site: 'a.com',
  accounts: [{ id: '1', label: '更旧的', lastUsedAt: '2020-01-01T00:00:00Z' }],
});
check('更旧的同 id 被跳过', mergedAgain.skipped, 1);
check('旧标签没有覆盖新标签', mergedAgain.file.accounts.find((a) => a.id === '1').label, '新的');

await writeSiteFile('a.com', merged.file);
check('clearAll 删除所有站点', await clearAll(), 1);
check('clearAll 后列表为空', (await listSiteFiles()).length, 0);

/* ----------------------------- 汇总 ----------------------------- */
console.log(`\n${'─'.repeat(48)}`);
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项`);
  process.exit(0);
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：\n`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
