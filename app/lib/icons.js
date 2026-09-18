/* Inline stroke icons on a 24px grid. Drawn here rather than loaded from an
   icon font, because the app makes no network requests at all. */

const P = {
  folder: 'M3.5 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z',
  folderOpen: 'M3.5 17V7.5A1.5 1.5 0 0 1 5 6h4l2 2h6.5A1.5 1.5 0 0 1 19 9.5V10 M3.5 17l2.6-6.1a1.5 1.5 0 0 1 1.4-.9h12.4a1 1 0 0 1 .9 1.4l-2.3 5.7a1.5 1.5 0 0 1-1.4.9H5a1.5 1.5 0 0 1-1.5-1z',
  folderPlus: 'M3.5 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z M12 11v5 M9.5 13.5h5',
  tray: 'M4 13.5h4.5l1.2 2h4.6l1.2-2H20 M4 13.5 6.2 6.6A1 1 0 0 1 7.2 6h9.6a1 1 0 0 1 1 .6l2.2 6.9V18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z',
  chevR: 'M10 7l5 5-5 5',
  chevD: 'M7 10l5 5 5-5',
  chevL: 'M14 7l-5 5 5 5',
  msg: 'M5 5.5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5V16.5H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z',
  star: 'M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z',
  archive: 'M4 5.5h16v3.5H4z M5.5 9v9.5h13V9 M10 12.5h4',
  hash: 'M5 9.5h14 M5 14.5h14 M10.5 4.5l-2 15 M15.5 4.5l-2 15',
  search: 'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z M19.5 19.5l-4.7-4.7',
  plus: 'M12 5.5v13 M5.5 12h13',
  dots: 'M6 12h.01 M12 12h.01 M18 12h.01',
  x: 'M7 7l10 10 M17 7L7 17',
  import: 'M12 4.5v10 M8 10.5l4 4 4-4 M5 15.5v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3',
  trash: 'M5 7h14 M10 7V5h4v2 M6.5 7l.9 11.1a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7',
  sun: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M12 3v1.5 M12 19.5V21 M4.2 4.2l1.1 1.1 M18.7 18.7l1.1 1.1 M3 12h1.5 M19.5 12H21 M4.2 19.8l1.1-1.1 M18.7 5.3l1.1-1.1',
  moon: 'M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z',
  monitor: 'M4 5.5h16v10H4z M9 19.5h6 M12 15.5v4',
  sidebarL: 'M4.5 5h15v14h-15z M9.5 5v14',
  sidebarR: 'M4.5 5h15v14h-15z M14.5 5v14',
  external: 'M13.5 5.5h5v5 M18.5 5.5l-7 7 M17 13.5v4.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5',
  rows: 'M5 6.5h14 M5 12h14 M5 17.5h9',
  outline: 'M5 6.5h1.5 M10 6.5h9 M5 12h1.5 M10 12h9 M5 17.5h1.5 M10 17.5h9',
  focus: 'M4 5.5h6a2 2 0 0 1 2 2v11a1.5 1.5 0 0 0-1.5-1.5H4z M20 5.5h-6a2 2 0 0 0-2 2v11a1.5 1.5 0 0 1 1.5-1.5H20z',
  pencil: 'M5 19h3.5L18.2 9.3a1.8 1.8 0 0 0-2.5-2.5L6 16.5z M14.5 8l2.5 2.5',
  bookmark: 'M7.5 4.5h9v15l-4.5-3.5-4.5 3.5z',
  check: 'M5.5 12.5l4 4 9-9',
  copy: 'M9 9h10v10H9z M15 9V5.5a.5.5 0 0 0-.5-.5h-9a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5H9',
  save: 'M6 4.5h9.5l3 3V18.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z M8.5 4.5v4h6v-4 M8 19.5v-5h8v5',
  file: 'M7 4.5h6.5l4 4v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z M13.5 4.5v4h4',
  image: 'M5 5.5h14a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z M4 15.5l4.5-4.5 4 4 2.5-2.5 5 5 M15 9.5h.01',
  arrowL: 'M19 12H5 M11 6l-6 6 6 6',
  arrowR: 'M5 12h14 M13 6l6 6-6 6',
  branch: 'M7 5v14 M17 7.5a2 2 0 1 0 0 .01 M17 9.5c0 4-10 3-10 7',
  columns: 'M4.5 5.5h4.5v13H4.5z M9.75 5.5h4.5v13h-4.5z M15 5.5h4.5v9H15z',
  swap: 'M6 8.5h12 M14.5 5l3.5 3.5-3.5 3.5 M18 15.5H6 M9.5 12l-3.5 3.5 3.5 3.5',
};

const NS = 'http://www.w3.org/2000/svg';

export function icon(name, size = 16) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', name === 'dots' ? '3.6' : '1.7');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.classList.add('i', `i-${name}`);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', P[name] || '');
  s.append(p);
  return s;
}
