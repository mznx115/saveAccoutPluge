/**
 * document_start 注入：在页面自身脚本执行之前，把待恢复的 localStorage /
 * sessionStorage 写回去，页面第一次读取登录态时就已经是恢复后的值。
 *
 * 数据由 background.js 预先放在 chrome.storage.session.pendingStorage 里，
 * 按 origin 索引。写完即销毁对应条目，避免后续导航重复写入。
 */
(async () => {
  try {
    const origin = location.origin;
    if (!origin || origin === 'null') return;

    const bag = await chrome.storage.session.get('pendingStorage');
    const pending = bag && bag.pendingStorage;
    if (!pending || !pending.byOrigin || !pending.byOrigin[origin]) return;

    const { local = {}, session = {} } = pending.byOrigin[origin];

    for (const [key, value] of Object.entries(local)) {
      try {
        localStorage.setItem(key, value);
      } catch { /* 单条写失败不影响其余 */ }
    }
    for (const [key, value] of Object.entries(session)) {
      try {
        sessionStorage.setItem(key, value);
      } catch { /* 同上 */ }
    }

    delete pending.byOrigin[origin];
    await chrome.storage.session.set({ pendingStorage: pending });
  } catch (err) {
    // document_start 阶段任何异常都不该影响页面本身
  }
})();
