/**
 * Minimal RFC 4180 reader for the committed seed files: quoted fields, doubled quotes, CRLF or
 * LF, optional UTF-8 BOM. Rows are keyed by header name; the seed files are written by
 * scripts/fetch-seed-data.mjs so the header set is known.
 */

export function parseCsv(text: string, delimiter = ','): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type CsvRecord = Readonly<Record<string, string>>;

export function parseCsvRecords(text: string, delimiter = ','): CsvRecord[] {
  const rows = parseCsv(text, delimiter);
  const header = rows.shift();
  if (header === undefined) {
    throw new Error('empty CSV');
  }
  return rows
    .filter((cells) => cells.length > 1 || (cells.length === 1 && cells[0] !== ''))
    .map((cells) => {
      const record: Record<string, string> = {};
      header.forEach((name, index) => {
        record[name] = cells[index] ?? '';
      });
      return record;
    });
}

/** Reads a required column; throws when the header is missing so a drifted file fails loudly. */
export function column(record: CsvRecord, name: string): string {
  const value = record[name];
  if (value === undefined) {
    throw new Error(`seed file is missing column "${name}"`);
  }
  return value;
}

export function optional(value: string): string | null {
  return value === '' ? null : value;
}

export function optionalInt(value: string): number | null {
  if (value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`expected an integer, got "${value}"`);
  }
  return n;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
