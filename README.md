# 保存账号插件

Chrome / Edge（Manifest V3）扩展：把当前站点的 **Cookie + localStorage + sessionStorage** 快照保存下来，
按**二级域名**（注册域 eTLD+1）分组，然后清空这三项、登录新账号，随时一键切回旧账号。

数据只存在这台电脑上，**全程不联网、不上传任何数据**。

```
数据：插件内部存储（chrome.storage.local，已申请 unlimitedStorage）
导出：只有你主动点「导出」时才写文件 → <下载目录>\保存账号插件\taobao.com.json
```

---

## 1. 安装（开发者模式加载）

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）。
2. 右上角打开「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本目录 `D:\code\保存账号插件`。
4. 建议把插件固定到工具栏。

> 需要 Chrome / Edge 116 及以上。

## 2. 使用（零配置）

1. 打开要保存账号的网站并登录。
2. 点插件图标 →「保存当前账号」（首次会弹一次「读取该网站数据」的授权，只针对这一个域名）。
3. 想换新账号 →「清空并重新登录」，页面会刷新到未登录状态，登录另一个号后再保存一次。
4. 之后在账号列表里点「切换」即可来回切。

**保存不会产生任何下载**，数据直接进插件内部存储。只有你在管理页（或 popup 底部）点「导出」时才会写文件。

只有一件事建议做：到管理页设置一个**口令**（启用加密），否则快照里的 Cookie 是明文。**默认是未加密状态**，装好就能直接保存，不会被锁住。

> 如果你之前装过旧版本，可能残留了「显示已加密但没有口令」的状态——现在读取设置时会自动纠正为未加密，直接保存即可；想加密就到管理页设置口令。

## 3. 数据放在哪

| | 位置 | 说明 |
|---|---|---|
| 数据 | 插件内部存储 | 无需任何目录授权，浏览器重启也不会失效；在管理页能看到占用大小 |
| 导出文件 | `<下载目录>\保存账号插件-全部账号-YYYYMMDD-hhmmss.json` | **仅在你点「导出」时生成**，所有域名打包成**一个文件** |
| 云同步 | WebDAV（坚果云等） | 手动点「同步」时才联网，远端同样是**一个文件** |

浏览器不允许插件在未授权的情况下写任意目录，所以导出位置固定为**下载目录**。
导出的文件可以搬走或备份，需要时用管理页的「导入账号文件」一次性读回来，**导入导出都不区分域名**。

> 若 Chrome 的「下载前询问每个文件的保存位置」是开着的，导出时会弹一次保存框，可在 `chrome://settings/downloads` 关掉。

### 导出文件结构

```jsonc
{
  "format": "save-account-plugin.bundle",
  "schemaVersion": 1,
  "exportedAt": "2026-01-02T03:04:05.000Z",
  "siteCount": 3,
  "sites": {
    "taobao.com":   { /* 站点文件：accounts / hosts / kdf ... */ },
    "github.com":   { /* ... */ },
    "bilibili.com": { /* ... */ }
  }
}
```

导入时也兼容**以前导出的单站点 `.json`**（含 `accounts` 数组的那种），以及没有 `format` 标记但带 `sites` 的宽松格式。

## 3b. WebDAV 同步（坚果云）

管理页第 2 节，或 popup 底部的「同步」按钮。

| 字段 | 说明 |
|---|---|
| 服务地址 | 坚果云默认 `https://dav.jianguoyun.com/dav/` |
| 邮箱或用户名 | 坚果云用**账号邮箱** |
| 应用密码 | 坚果云 →「账户信息 → 安全选项 → 添加应用密码」生成。**填登录密码会返回 401** |
| 远端目录 | 默认 `save-accout-plugin`，只管理该目录下的备份文件 |

远端只存一个文件：`<目录>/save-account-plugin.bundle.json`。

### 同步顺序（重要）

```
1. MKCOL  确保远端目录存在
2. GET    下载远端 bundle（不存在则视为空）
3. 合并   远端每个站点按账号 id 并入本地，写回本地存储
4. PUT    把合并后的全部站点打包上传
```

**为什么必须"先下载再上传"**：如果直接 PUT，会用本地数据覆盖远端，另一台设备上新增的账号就没了。先下载再合并，两台设备各自新增的账号都会保留。

合并去重规则：
- 同 `id` → 取 `lastUsedAt` 更新的那条
- `id` 不同但**账号名（label）相同** → 视为同一账号，同样取较新的（避免两台设备各存一份"主号"）
- 站点级取并集

### 权限

WebDAV 的访问权限是**点同步时按需申请**的，只申请你填写的那个服务器域名（例如 `https://dav.jianguoyun.com/*`），而不是安装时就申请"所有网站"。所以装插件时不会出现吓人的授权提示。

### 加密一致性

如果本地和远端用了**不同的口令**（盐值不同），同步会直接报错拒绝，而不是合并出一堆解不开的账号。
一侧加密、另一侧有明文账号时同样拒绝。解决方式是先在两端统一口令。

## 4. 目录结构

```
manifest.json          MV3 清单
background.js          Service Worker：cookie 读写 + 注入编排（不碰文件、不碰网络）
popup/                 工具栏面板：保存 / 清空 / 切换 / 解锁 / 导出
options/               管理页：存储与导出、加密、设置、账号清单、导入
content/
  restore-at-start.js  document_start 注入，在页面脚本之前写回 localStorage
lib/
  site.js              eTLD+1 归组、文件名合法化
  cookies.js           cookie 采集 / 清空 / 写回（含 HttpOnly、CHIPS 分区）
  crypto.js            PBKDF2-SHA256 + AES-GCM
  schema.js            快照结构、加锁 / 解锁 / 账号读写
  store.js             数据存储：chrome.storage.local 的读写与合并
  bundle.js            全部域名打包成单个文件导出、导入拆包（仅手动触发）
  webdav.js            WebDAV 客户端（唯一会联网的模块）
  sync.js              同步编排：下载 → 合并 → 上传
  settings.js          设置 + 仅内存的密钥缓存
  errors.js / ui.js / bus.js / host-permission.js
  vendor/psl-data.js   公共后缀表（自动生成，勿手改）
tools/                 构建与检查脚本
tests/run.mjs          纯逻辑单测
```

## 5. 开发命令

```powershell
node tests/run.mjs        # 纯逻辑单测（域名归组 / 加解密 / 快照 / 存储层 / 导入合并）
node tools/check.mjs      # 静态自检（manifest、import 路径、权限声明、是否偷偷联网）
node tools/build-psl.mjs  # 重新拉取 publicsuffix.org 并生成 lib/vendor/psl-data.js
pwsh -File tools/make-icons.ps1   # 重新生成图标
```

改完代码后到 `chrome://extensions` 点插件卡片上的刷新按钮即可。

## 6. 关键设计说明

| 主题 | 做法 |
|---|---|
| 为什么不用「选一个本地文件夹」 | File System Access 需要用户授权、浏览器重启后经常要重新授权，体验差。改为数据存插件内部，零授权 |
| **保存不会产生下载** | 保存只写 `chrome.storage.local`。下载只由用户显式点「导出」触发；`tools/check.mjs` 有静态守卫，防止 `doSave` 里再混入下载调用 |
| 为什么 Service Worker 不写文件 | `URL.createObjectURL` 在 SW 里不可用，导出只能在有 DOM 的页面（popup / 管理页）里发起 |
| **导入导出不分域名** | 所有域名打包进**一个** `sites` 对象，几十个域名也只有一个文件；导入时拆包逐站点合并。以前导出的单站点文件仍可导入 |
| 导出覆盖而不是新增 | `conflictAction: 'overwrite'`；文件名带时间戳，所以每次导出是一个新备份而不是互相覆盖 |
| 二级域名 | 内置 publicsuffix.org 的 ICANN + PRIVATE 规则（6949 + 3450 条），`foo.github.io`、`a.b.co.uk`、`www.ck` 等边界情况都有单测覆盖 |
| localStorage 为什么要按 origin 存 | localStorage 是 per-origin 的，`www.taobao.com` 与 `detail.taobao.com` 各有一份 |
| 恢复登录态的时机 | 先写 cookie（必须早于导航），再靠 `runAt: 'document_start'` 的内容脚本在页面自身 JS 之前写回 storage；注册失败时退回「加载完 → 注入 → 刷新一次」 |
| 加密 | PBKDF2-SHA256(600k) 派生 AES-GCM 256；盐是安装级的，每个账号每次写入用新的随机 IV；未解锁时也能从明文元数据列出账号名 |
| 密钥存放 | 只把派生出的 raw key 放在 `chrome.storage.session`（纯内存，关浏览器即失效），从不保存口令 |
| 用户手势 | `chrome.permissions.request` 必须在点击后**第一时间**调用，中间不要插 `await`，否则 Chrome 会认为手势失效 |

## 7. 手动验收清单（浏览器里跑一遍）

- [ ] 加载插件后点图标，能正确显示当前站点（`chrome://` 页面会提示不支持）
- [ ] 首次保存时弹出「读取该网站数据」授权，允许后成功保存
- [ ] **保存后下载目录里没有出现任何新文件**（这是关键回归点）
- [ ] 在几个不同域名各保存一个账号，然后点「导出全部」→ 下载目录里只出现**一个** `保存账号插件-全部账号-*.json`
- [ ] 打开那个文件，`sites` 里能看到全部域名，且**没有明文 cookie 值**（若已开加密）
- [ ] 删掉插件内部数据（管理页「删除全部快照」）后，用「导入账号文件」选那一个文件 → 所有域名一次性恢复
- [ ] 导入重复文件不会产生重复账号（同 id 跳过）
- [ ] 「清空并重新登录」后页面确实未登录
- [ ] 登录账号乙并保存 → 在列表里点「甲」→ 页面变回甲的登录态
- [ ] 在 `www.taobao.com` 保存后，打开 `detail.taobao.com` 也能看到同一个账号列表（二级域名归组）
- [ ] 加密：启用后重启浏览器，popup 要求解锁；错误口令被拒绝
- [ ] `chrome://extensions` 的 Service Worker 控制台无报错

## 8. 已知限制

- 导出只能落在**下载目录**，这是浏览器对扩展的硬限制；想放到别处请手动搬运。导出文件是单个自包含 JSON，搬走很方便。
- `sessionStorage` 是 per-tab 的，恢复只在插件打开/刷新的那个标签页内有效。
- `document_start` 注入依赖一次异步的 `chrome.storage.session` 读取（约 1~3ms）。极少数在首个内联 `<script>` 里同步读 localStorage 的站点可能仍需要再刷新一次。
- 换口令或开关加密会重写全部快照，站点多时需要几秒。
- 隐身窗口的 cookie 默认不处理（可在管理页打开开关）。
- 插件内部存储随「移除扩展」一起消失，重要数据请用「导出全部」留一份备份。
