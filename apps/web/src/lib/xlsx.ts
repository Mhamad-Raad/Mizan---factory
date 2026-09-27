import { strToU8 as encode, zipSync } from 'fflate';

/** Text as bytes, always as this realm's `Uint8Array`, which is what the zip writer recognises. */
const strToU8 = (text: string): Uint8Array => new Uint8Array(encode(text));

/**
 * A small Excel (.xlsx) writer for the Reports page (client review).
 *
 * An .xlsx file is a zip of a few XML parts; writing them directly keeps the app free of a large
 * spreadsheet library for what is always the same shape: a title, the period, a header row, the
 * rows and a totals row, one sheet per report. Numbers are written as numbers — never as text —
 * so Excel adds them up, with a display format per column: whole dinars, dollars with cents,
 * kilograms to the gram. A Kurdish or Arabic workbook opens right to left.
 */

export type CellFormat = 'text' | 'integer' | 'usd' | 'kg';

export interface SheetColumn {
  header: string;
  format: CellFormat;
  /** Width in characters; a sensible one is picked from the header when absent. */
  width?: number;
}

export type Cell = string | number | null;

export interface Sheet {
  /** Sheet tab name — Excel allows 31 characters and none of : \ / ? * [ ]. */
  name: string;
  title: string;
  subtitle?: string;
  columns: SheetColumn[];
  rows: Cell[][];
  /** A last, bold row — the report's totals. */
  totals?: Cell[];
}

// Styles (cellXfs index): 0 plain, 1 bold header, 2 integer, 3 usd, 4 kg, 5 title, 6 bold integer,
// 7 bold usd, 8 bold kg, 9 bold text.
const STYLE: Record<CellFormat, number> = { text: 0, integer: 2, usd: 3, kg: 4 };
const BOLD_STYLE: Record<CellFormat, number> = { text: 9, integer: 6, usd: 7, kg: 8 };

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not allowed in XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** A1-style column letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function cellXml(ref: string, value: Cell, style: number): string {
  if (value === null || value === '') return `<c r="${ref}" s="${style}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

function sheetXml(sheet: Sheet, rtl: boolean): string {
  const rows: string[] = [];
  let r = 1;
  rows.push(`<row r="${r}">${cellXml(`A${r}`, sheet.title, 5)}</row>`);
  r += 1;
  if (sheet.subtitle) {
    rows.push(`<row r="${r}">${cellXml(`A${r}`, sheet.subtitle, 0)}</row>`);
    r += 1;
  }
  r += 1; // a blank line before the table
  const headerRow = r;
  rows.push(
    `<row r="${r}">${sheet.columns.map((column, index) => cellXml(`${columnName(index)}${r}`, column.header, 1)).join('')}</row>`,
  );
  r += 1;
  for (const row of sheet.rows) {
    rows.push(
      `<row r="${r}">${sheet.columns
        .map((column, index) => cellXml(`${columnName(index)}${r}`, row[index] ?? null, STYLE[column.format]))
        .join('')}</row>`,
    );
    r += 1;
  }
  if (sheet.totals) {
    rows.push(
      `<row r="${r}">${sheet.columns
        .map((column, index) => cellXml(`${columnName(index)}${r}`, sheet.totals?.[index] ?? null, BOLD_STYLE[column.format]))
        .join('')}</row>`,
    );
  }
  const cols = sheet.columns
    .map((column, index) => {
      const width = column.width ?? Math.min(Math.max(column.header.length + 4, column.format === 'text' ? 22 : 14), 48);
      return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
    })
    .join('');
  const lastColumn = columnName(Math.max(sheet.columns.length - 1, 0));
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetViews><sheetView workbookViewId="0"${rtl ? ' rightToLeft="1"' : ''}>` +
    // The header row stays in view while scrolling down a long report.
    `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>` +
    '</sheetView></sheetViews>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    (sheet.rows.length > 0 ? `<autoFilter ref="A${headerRow}:${lastColumn}${headerRow + sheet.rows.length}"/>` : '') +
    '</worksheet>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.###"/></numFmts>' +
  '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="14"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEEF3F0"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left/><right/><top/><bottom style="thin"><color rgb="FF7C8A82"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="10">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="3" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="165" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** A sheet name Excel accepts: at most 31 characters, none of : \ / ? * [ ], unique. */
function sheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let candidate = base;
  let index = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${index})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    index += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** The workbook as bytes. */
export function buildXlsx(sheets: readonly Sheet[], options: { rtl?: boolean } = {}): Uint8Array {
  const used = new Set<string>();
  const names = sheets.map((sheet) => sheetName(sheet.name, used));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets
          .map(
            (_, index) =>
              `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<bookViews><workbookView${options.rtl ? ' rightToLeft="1"' : ''}/></bookViews>` +
        `<sheets>${names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>` +
        '</workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (_, index) =>
              `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(STYLES_XML),
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheetXml(sheet, Boolean(options.rtl)));
  });
  return zipSync(files, { level: 6 });
}

/** Builds the workbook and hands it to the browser as a download. */
export function downloadXlsx(fileName: string, sheets: readonly Sheet[], options: { rtl?: boolean } = {}): void {
  const bytes = buildXlsx(sheets, options);
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
