/** A small RFC 4180 CSV reader (quoted fields, doubled quotes, CRLF). No dependency for a 60-line job. */

export interface Table {
  header: string[];
  rows: string[][];
  /** Column index by name; -1 if absent. */
  col(name: string): number;
}

export function parseCsv(text: string): Table {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const n = text.length;
  let quoted = false;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (quoted) {
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      const next = text.indexOf('"', i);
      const end = next < 0 ? n : next;
      field += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === 34 && field === '') {
      quoted = true;
      i++;
    } else if (c === 44) {
      row.push(field);
      field = '';
      i++;
    } else if (c === 10 || c === 13) {
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    } else {
      // fast path: copy up to the next delimiter
      let j = i;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 44 || d === 10 || d === 13 || d === 34) break;
        j++;
      }
      if (j === i) {
        field += text[i];
        j = i + 1;
      } else field += text.slice(i, j);
      i = j;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = (rows.shift() ?? []).map((h) => h.replace(/^﻿/, ''));
  const at = new Map(header.map((h, k) => [h, k]));
  return { header, rows, col: (name) => at.get(name) ?? -1 };
}

/** Accessors for one table: missing columns and NA read as empty / 0. */
export function reader(t: Table) {
  const idx = new Map<string, number>();
  const ix = (name: string): number => {
    let k = idx.get(name);
    if (k === undefined) idx.set(name, (k = t.col(name)));
    return k;
  };
  return {
    has: (name: string): boolean => ix(name) >= 0,
    str: (r: string[], name: string): string => {
      const k = ix(name);
      const v = k >= 0 ? (r[k] ?? '') : '';
      return v === 'NA' ? '' : v;
    },
    num: (r: string[], name: string): number => {
      const k = ix(name);
      const v = k >= 0 ? (r[k] ?? '') : '';
      if (v === '' || v === 'NA') return 0;
      const x = Number(v);
      return Number.isFinite(x) ? x : 0;
    },
    /** null when empty / NA / not a number. */
    opt: (r: string[], name: string): number | null => {
      const k = ix(name);
      const v = k >= 0 ? (r[k] ?? '') : '';
      if (v === '' || v === 'NA') return null;
      const x = Number(v);
      return Number.isFinite(x) ? x : null;
    },
  };
}
