export interface NameRow {
  first: string;
  last: string;
  line: number;
}

export interface ParseResult {
  rows: NameRow[];
  /** Human-readable notes: delimiter guessed, header dropped, rows skipped. */
  notes: string[];
}

/** RFC4180-ish split of one line, honouring quotes and doubled quotes. */
const splitLine = (line: string, delim: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
};

const HEADER_FIRST = /^(first|first ?name|given|imi[eę]|imie)$/i;
const HEADER_LAST = /^(last|last ?name|surname|family|nazwisko)$/i;

/**
 * Parse a guest list. Delimiter is sniffed rather than assumed: Polish Excel
 * writes semicolons, and a list of names is exactly the case where commas and
 * tabs both show up in the wild.
 */
export const parseNames = (text: string): ParseResult => {
  const notes: string[] = [];
  // Strip a UTF-8 BOM, which Excel writes and which would otherwise become
  // part of the first name on row one.
  const body = text.replace(/^﻿/, '');
  const lines = body.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { rows: [], notes: ['the file is empty'] };

  const candidates = [';', ',', '\t', '|'];
  const score = (d: string): number => {
    const counts = lines.slice(0, 20).map((l) => splitLine(l, d).length);
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)] ?? 1;
    return mode > 1 ? mode : 0;
  };
  const delim = candidates.reduce((best, d) => (score(d) > score(best) ? d : best), candidates[0]!);
  const columns = score(delim);
  if (columns > 1) notes.push(`delimiter "${delim === '\t' ? 'tab' : delim}"`);

  let start = 0;
  let firstCol = 0;
  let lastCol = 1;

  const head = splitLine(lines[0]!, delim);
  const hasHeader = head.some((h) => HEADER_FIRST.test(h)) || head.some((h) => HEADER_LAST.test(h));
  if (hasHeader) {
    const fi = head.findIndex((h) => HEADER_FIRST.test(h));
    const li = head.findIndex((h) => HEADER_LAST.test(h));
    if (fi >= 0) firstCol = fi;
    if (li >= 0) lastCol = li;
    start = 1;
    notes.push('header row detected');
  }

  const rows: NameRow[] = [];
  let skipped = 0;
  for (let i = start; i < lines.length; i++) {
    const cells = splitLine(lines[i]!, delim);
    let first = cells[firstCol] ?? '';
    let last = cells[lastCol] ?? '';

    // A single-column file is "First Last" in one cell; split on the last space
    // so multi-part given names stay together.
    if (columns <= 1 || (last === '' && first.includes(' '))) {
      const whole = (cells[0] ?? '').trim();
      const cut = whole.lastIndexOf(' ');
      if (cut > 0) { first = whole.slice(0, cut); last = whole.slice(cut + 1); }
      else { first = whole; last = ''; }
    }

    if (!first && !last) { skipped++; continue; }
    rows.push({ first, last, line: i + 1 });
  }
  if (skipped) notes.push(`${skipped} blank row${skipped === 1 ? '' : 's'} skipped`);
  notes.push(`${rows.length} name${rows.length === 1 ? '' : 's'}`);

  return { rows, notes };
};

export const toCsv = (rows: NameRow[]): string =>
  ['first,last', ...rows.map((r) => `${quote(r.first)},${quote(r.last)}`)].join('\n');

const quote = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
