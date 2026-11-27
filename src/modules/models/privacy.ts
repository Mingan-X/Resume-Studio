// Preserve UTF-16 positions so quotations still bind to the original document.
// Mask common contact forms, never collapse or normalize whitespace here.
export function redactContactText(text: string): string {
  const mask = (value: string) => value.replace(/[^\r\n]/g, '█');
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, mask)
    .replace(/(?:https?:\/\/|www\.)[^\s<>"']+/gi, mask)
    .replace(/(?<!\d)(?:\+?\d[\d ()-]{6,}\d)(?!\d)/g, mask)
    .replace(/(?:微信|wechat|weixin|QQ|联系地址|通讯地址|邮箱|联系电话|手机)\s*[:：]\s*[^\r\n]+/gi, mask);
}
