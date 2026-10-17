/** 把各种异常翻译成人能看懂的中文提示。 */

export function fileSystemErrorMessage(err) {
  const name = err?.name || '';
  switch (name) {
    case 'NotFoundError':
      return '文件或文件夹不存在';
    case 'NotAllowedError':
      return '没有权限（可能需要在管理页重新授权保存目录）';
    case 'AbortError':
      return '用户取消了操作';
    case 'InvalidModificationError':
      return '目录结构被外部修改';
    case 'NoModificationAllowedError':
      return '文件被其他程序占用';
    case 'QuotaExceededError':
      return '磁盘空间不足';
    case 'SecurityError':
      return '安全限制：必须由点击操作触发';
    default:
      return err?.message || String(err);
  }
}

export function presentError(err) {
  if (!err) return '未知错误';
  const msg = err.message || String(err);
  if (msg === 'LOCKED') return '文件已加密，请先输入口令解锁';
  return msg;
}
