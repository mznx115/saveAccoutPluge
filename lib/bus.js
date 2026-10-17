/** 与 Service Worker 通信的小封装。 */

export async function call(type, payload = {}) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (err) {
    throw new Error(`后台无响应（${err.message}）。可在 chrome://extensions 里重新加载插件试试。`);
  }
  if (!res) throw new Error('后台无响应');
  if (res.ok === false) throw new Error(res.error || '操作失败');
  return res.data !== undefined ? res.data : res;
}
