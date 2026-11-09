/** Tiny DOM helpers. No innerHTML anywhere: all text goes in as text. */
export interface ElOptions {
  text?: string;
  className?: string;
  onClick?: (e: MouseEvent) => void;
  attrs?: Record<string, string>;
  /** CSS custom properties, set through the CSSOM (allowed by the host's CSP, unlike style attributes in markup). */
  vars?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, opts: ElOptions = {}, children: (Node | null | false)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.className) node.className = opts.className;
  if (opts.onClick) node.addEventListener('click', opts.onClick as EventListener);
  for (const [k, v] of Object.entries(opts.attrs ?? {})) node.setAttribute(k, v);
  for (const [k, v] of Object.entries(opts.vars ?? {})) node.style.setProperty(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

export function render(root: Node): void {
  const app = document.getElementById('app');
  if (app) app.replaceChildren(root);
}
