// Small UI toolkit: safe element builder (never innerHTML with data), icons, sheets, toasts.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Optional children are written as `cond ? el : null`; never let the DOM print "null".
for (const method of ['append', 'replaceChildren', 'prepend']) {
  const original = Element.prototype[method];
  Element.prototype[method] = function (...kids) {
    return original.apply(this, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  };
}

const SVG = 'http://www.w3.org/2000/svg';
const PATHS = {
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.5V20h5v-6h4v6h5V9.5'],
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v3'],
  chat: ['M4 5h16v11H9l-5 4V5Z'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'],
  calendar: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  bell: ['M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Z', 'M10 20a2 2 0 0 0 4 0'],
  note: ['M5 3h10l4 4v14H5z', 'M15 3v4h4', 'M8 12h8', 'M8 16h6'],
  message: ['M4 5h16v11H9l-5 4V5Z', 'M8 9h8', 'M8 12h5'],
  timer: ['M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'M12 9v4l2.5 2', 'M9 2h6'],
  bag: ['M5 8h14l-1 12H6L5 8Z', 'M9 8V6a3 3 0 0 1 6 0v2'],
  check: ['M5 12.5 10 17l9-10'],
  plus: ['M12 5v14', 'M5 12h14'],
  chevron: ['M9 6l6 6-6 6'],
  back: ['M15 6l-6 6 6 6'],
  phone: ['M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z'],
  music: ['M9 18V5l11-2v13', 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'M20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  mail: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
  video: ['M3 7h12v10H3z', 'M15 10l6-3v10l-6-3'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  send: ['M4 12 20 4l-6 16-3-7-7-1Z'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  users: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M2 21a7 7 0 0 1 14 0', 'M16 3.5a4 4 0 0 1 0 7', 'M22 21a7 7 0 0 0-4-6.3'],
  sparkle: ['M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Z'],
  speaker: ['M4 9h4l5-4v14l-5-4H4z', 'M16.5 8.5a5 5 0 0 1 0 7', 'M19 6a8.5 8.5 0 0 1 0 12'],
  speakerOff: ['M4 9h4l5-4v14l-5-4H4z', 'M17 9l5 6', 'M22 9l-5 6'],
  iphone: ['M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z', 'M11 18h2'],
};

export function icon(name, size = 22) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name] ?? []) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** The Brain Dump mark: a thought bubble with a sprig. Used for the talk button and header. */
export function brandMark(size = 28, { onDark = false } = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 512 512');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const cloud = onDark ? '#ffffff' : 'var(--accent)';
  const sprig = onDark ? 'var(--accent)' : '#ffffff';
  svg.innerHTML = `<g transform="translate(0,-16)">
    <path d="M170 318c-38 0-66-27-66-62 0-33 25-59 58-62 8-42 45-72 90-72 38 0 71 22 85 55 5-1 10-1 15-1 44 0 78 33 78 74s-34 68-78 68H170z" fill="${cloud}"/>
    <circle cx="176" cy="372" r="20" fill="${cloud}"/><circle cx="138" cy="410" r="11" fill="${cloud}"/>
    <path d="M256 290c0-40 6-70 22-100" fill="none" stroke="${sprig}" stroke-width="12" stroke-linecap="round"/>
    <path d="M262 244c-26-4-44-20-48-44 26 2 44 18 48 44z" fill="${sprig}"/>
    <path d="M270 212c20-12 44-12 62 4-20 14-44 12-62-4z" fill="${sprig}"/></g>`;
  return svg;
}

export function toast(text, actions = [], timeout = 6000) {
  const box = h('div', { class: 'toast', role: 'status' }, h('div', { class: 'toast-text' }, text));
  if (actions.length) {
    box.append(h('div', { class: 'row-actions' }, actions.map((a) => h('button', { class: 'pill-btn', onclick: () => { a.run(); box.remove(); } }, a.label))));
  }
  document.getElementById('toasts').append(box);
  if (timeout) setTimeout(() => box.remove(), timeout);
  return box;
}

/** A bottom sheet. Returns a close function. */
export function sheet(title, ...content) {
  const close = () => {
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 180);
  };
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-grip' }),
    h('div', { class: 'sheet-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
    h('div', { class: 'sheet-body' }, ...content));
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => e.target === wrap && close() }, panel);
  document.body.append(wrap);
  setTimeout(() => panel.querySelector('input, textarea')?.focus(), 250);
  return close;
}

export function copyButton(text, label = 'Copy') {
  return h('button', { class: 'pill-btn', type: 'button', onclick: async (e) => {
    try {
      await navigator.clipboard.writeText(text);
      e.currentTarget.textContent = 'Copied ✓';
    } catch {
      e.currentTarget.textContent = 'Press and hold the text to copy';
    }
  } }, label);
}

/** Pick an icon for an action link from where it goes. */
export function linkIcon(url) {
  if (/wa\.me|whatsapp/.test(url)) return 'message';
  if (/^sms:/.test(url)) return 'message';
  if (/^tel:/.test(url)) return 'phone';
  if (/^facetime:/.test(url)) return 'video';
  if (/^mailto:/.test(url)) return 'mail';
  if (/^shortcuts:/.test(url)) return 'iphone';
  if (/spotify|music\.apple|music\.youtube/.test(url)) return 'music';
  if (/zoom\.us|meet\.google|teams/.test(url)) return 'video';
  if (/\.ics|webcal/.test(url)) return 'calendar';
  return 'link';
}

export function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function fmtDay(iso) {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

export function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function isoDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
