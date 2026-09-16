'use strict';

// Tiny CSV writer for exports and backups (RFC 4180 quoting, Excel-friendly).

/**
 * Text that starts with = + @ (or - followed by a non-digit) can run as a formula when the
 * file is opened in a spreadsheet. Prefixing an apostrophe keeps it as plain text.
 * Numbers such as "-5" are left alone.
 */
function neutralize(value) {
  return /^(?:[=+@\t\r]|-(?![\d.]))/.test(value) ? `'${value}` : value;
}

function cell(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'string') s = neutralize(value);
  else s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** rows: array of objects; columns: the keys to write, in order (also used as the header). */
function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  // The BOM makes Excel open the file as UTF-8 (names with accents, symbols, etc.).
  return `﻿${lines.join('\r\n')}\r\n`;
}

module.exports = { toCsv };
