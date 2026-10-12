export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '', parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = (parent?.ownerDocument ?? document).createElement(tag); if (className) node.className = className; if (text) node.textContent = text; if (parent) parent.append(node); return node;
}
export function button(parent: HTMLElement, text: string, action: () => void | Promise<void>, className = ''): HTMLButtonElement {
  const node = el('button', className, text, parent); node.type = 'button'; node.addEventListener('click', () => { void action(); }); return node;
}
export function input(parent: HTMLElement, label: string, value: string, type = 'text', change?: (value: string) => void) {
  const wrap = el('label', 'll-field', '', parent); el('span', '', label, wrap);
  const node = el('input', '', '', wrap); node.type = type; node.value = value; node.setAttribute('aria-label', label);
  if (change) node.addEventListener('change', () => change(node.value)); return node;
}
export function select(parent: HTMLElement, label: string, value: string, options: [string, string][], change: (value: string) => void) {
  const wrap = el('label', 'll-field', '', parent); el('span', '', label, wrap);
  const node = el('select', '', '', wrap); node.setAttribute('aria-label', label);
  for (const [v, title] of options) { const o = el('option', '', title, node); o.value = v; }
  node.value = value; node.addEventListener('change', () => change(node.value)); return node;
}
export function check(parent: HTMLElement, label: string, value: boolean, change: (value: boolean) => void) {
  const wrap = el('label', 'll-check', '', parent); const node = el('input', '', '', wrap); node.type = 'checkbox'; node.checked = value; node.setAttribute('aria-label', label); el('span', '', label, wrap); node.addEventListener('change', () => change(node.checked)); return node;
}
export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })); const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function dialog(parent: HTMLElement, title: string, onClose?: () => void) {
  const node = el('dialog', 'll-dialog', '', parent); const header = el('header', 'll-dialog-header', '', node); el('h2', '', title, header);
  const close = () => { onClose?.(); node.close(); node.remove(); };
  button(header, '关闭', close); node.addEventListener('cancel', () => { onClose?.(); node.remove(); });
  node.showModal(); return { node, close };
}
