// Preserve UTF-16 positions so quotations still bind to the original document.
// Mask common contact forms, never collapse or normalize whitespace here.
export function redactContactText(text: string, redactLabels = true): string {
  const mask = (value: string) => value.replace(/[^\r\n]/g, '█');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const clean = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, mask)
    .replace(/(?:https?:\/\/|www\.)[^\s<>"']+/gi, mask)
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|(?<![a-zA-Z0-9-])(?:\+?\d[\d ()-]{6,}\d)(?![a-zA-Z0-9-])/gi,
      value => uuid.test(value) ? value : mask(value));
  return redactLabels ? clean.replace(/(?:微信|wechat|weixin|QQ|联系地址|通讯地址|邮箱|联系电话|手机)\s*[:：]\s*[^\r\n]+/gi, mask) : clean;
}
