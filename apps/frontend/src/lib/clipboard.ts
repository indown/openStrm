/**
 * 复制到剪贴板。navigator.clipboard 只在安全上下文里有（https、localhost）：
 * 局域网里用 http://nas:3000 这种地址打开时它是 undefined，退回老办法（藏起来的 textarea + execCommand）。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒之类：再试老办法
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const previous = document.activeElement as HTMLElement | null;
  // 放进当前弹框里：弹框会把焦点锁在自己里面，textarea 挂在 body 上一 focus 就被抢回去，选区跟着没了
  const host = previous?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? document.body;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  Object.assign(ta.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
  host.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
    previous?.focus();
  }
}
