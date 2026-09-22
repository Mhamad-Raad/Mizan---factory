import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Button, Card, Chip, SegmentedControl } from '@mizan/ui';
import { ApiError, apiRequest } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';

type ImportKind =
  | 'materials'
  | 'customers'
  | 'companies'
  | 'opening_stock'
  | 'customer_opening_balance'
  | 'company_opening_balance';

const KINDS: readonly { kind: ImportKind; required: string[]; optional: string[] }[] = [
  { kind: 'materials', required: ['name', 'pricing_unit'], optional: ['code', 'min_stock', 'notes'] },
  { kind: 'customers', required: ['name'], optional: ['phone', 'address', 'settlement_currency', 'notes'] },
  {
    kind: 'companies',
    required: ['name'],
    optional: ['contact_name', 'phone', 'address', 'settlement_currency', 'notes'],
  },
  { kind: 'opening_stock', required: ['material'], optional: ['qty_count', 'qty_kg', 'entry_date', 'note'] },
  {
    kind: 'customer_opening_balance',
    required: ['customer', 'amount', 'currency'],
    optional: ['entry_date', 'note'],
  },
  {
    kind: 'company_opening_balance',
    required: ['company', 'amount', 'currency'],
    optional: ['entry_date', 'note'],
  },
];

interface RowProblem {
  row: number;
  column: string | null;
  message_key: string;
  params: Record<string, unknown>;
}

interface PreviewResponse {
  kind: ImportKind;
  rows: number;
  ready: number;
  problems: RowProblem[];
  created?: number;
  failed?: { row: number; message_key: string; params: Record<string, unknown> }[];
}

/**
 * Reads a CSV the way a spreadsheet writes one.
 *
 * Quoted fields with commas and newlines inside them, doubled quotes for a literal one, a
 * byte-order mark at the front (Excel on Windows), and `\r\n` line endings. Deliberately not a
 * dependency: this is fifty lines, it runs on the admin's own device, and a parser nobody can
 * read is worse than one somebody can.
 */
export function parseCsv(text: string): Record<string, string | null>[] {
  const input = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (character !== '\r') {
      field += character;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((line) => line.some((cell) => cell.trim() !== ''));
  if (!header) return [];
  const columns = header.map((cell) => cell.trim().toLowerCase());

  return body.map((line) => {
    const record: Record<string, string | null> = {};
    for (const [index, column] of columns.entries()) {
      const value = (line[index] ?? '').trim();
      record[column] = value === '' ? null : value;
    }
    return record;
  });
}

/**
 * Import at go-live (FR-1312, **Proposed — not requested**).
 *
 * The file is read and parsed here, on the admin's device, and sent as rows — so the preview is
 * their own spreadsheet with the bad lines named, before anything reaches the server. The
 * import itself writes through the same endpoints the forms use, which is why an imported
 * opening debt is an ordinary ledger entry with an ordinary History row.
 */
export function ImportPage() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ImportKind>('materials');
  const [rows, setRows] = useState<Record<string, string | null>[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const template = KINDS.find((entry) => entry.kind === kind) as (typeof KINDS)[number];

  const send = useMutation({
    mutationFn: (mode: 'preview' | 'commit') =>
      apiRequest<PreviewResponse>(`/imports/${kind}${mode === 'preview' ? '/preview' : ''}`, {
        method: 'POST',
        body: { rows },
      }),
    onSuccess: (response) => {
      setResult(response);
      setError(null);
    },
    onError: (caught) => {
      setResult(null);
      setError(caught instanceof ApiError ? t('errors:VALIDATION_FAILED') : t('errors:INTERNAL'));
    },
  });

  const pick = async (file: File): Promise<void> => {
    const parsed = parseCsv(await file.text());
    setFileName(file.name);
    setRows(parsed);
    setResult(null);
    setError(parsed.length === 0 ? t('imports:empty_file') : null);
  };

  /** The empty template, built from the same column list the API declares. */
  const downloadTemplate = (): void => {
    const columns = [...template.required, ...template.optional];
    const csv = `${columns.join(',')}\n`;
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `mizan-${kind}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppShell title={t('imports:title')}>
      <div className="mz-stack">
        <Card>
          <div className="mz-stack">
            <p className="mz-caption">{t('imports:hint')}</p>
            <SegmentedControl
              label={t('imports:kind')}
              value={kind}
              onChange={(next) => {
                setKind(next);
                setRows([]);
                setFileName(null);
                setResult(null);
                setError(null);
              }}
              options={KINDS.map((entry) => ({ value: entry.kind, label: t(`imports:kind.${entry.kind}`) }))}
            />
            <p className="mz-caption">
              {t('imports:columns', {
                required: template.required.join(', '),
                optional: template.optional.join(', ') || '—',
              })}
            </p>
            <Button variant="ghost" block onClick={downloadTemplate}>
              {t('imports:template')}
            </Button>
          </div>
        </Card>

        <Card>
          <div className="mz-stack">
            <label className="mz-field">
              <span className="mz-field__label">{t('imports:choose_file')}</span>
              <input
                className="mz-field__control"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void pick(file);
                }}
              />
            </label>
            {fileName ? (
              <p className="mz-caption">
                {fileName} · {t('imports:rows_read', { count: rows.length })}
              </p>
            ) : null}
            {error ? (
              <p className="mz-field__error" role="alert">
                {error}
              </p>
            ) : null}
            {/* Ten thousand ledger entries are ten thousand transactions, which is the point:
                one bad row cannot lose the file. It takes about a minute, and somebody watching
                a button spin needs to be told that (system-wide review). */}
            {rows.length > 1000 ? <p className="mz-caption">{t('imports:patience')}</p> : null}
            <Button
              block
              variant="secondary"
              disabled={rows.length === 0}
              loading={send.isPending && send.variables === 'preview'}
              onClick={() => send.mutate('preview')}
            >
              {t('imports:preview')}
            </Button>
          </div>
        </Card>

        {result ? (
          <Card>
            <div className="mz-stack">
              <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <Chip tone={result.ready > 0 ? 'success' : 'neutral'}>
                  {t('imports:ready', { count: result.ready })}
                </Chip>
                {result.problems.length > 0 ? (
                  <Chip tone="warning" icon="warning">
                    {t('imports:problems', { count: new Set(result.problems.map((p) => p.row)).size })}
                  </Chip>
                ) : null}
                {result.created !== undefined ? (
                  <Chip tone="success" icon="check">
                    {t('imports:created', { count: result.created })}
                  </Chip>
                ) : null}
              </div>

              {/* Every problem names its row and its column, so the admin can fix the file. */}
              {result.problems.slice(0, 50).map((problem, index) => (
                <p key={`${problem.row}-${problem.column}-${index}`} className="mz-caption">
                  {t('imports:row_label', { row: problem.row })}
                  {problem.column ? ` · ${problem.column}` : ''} — {t(problem.message_key, problem.params)}
                </p>
              ))}
              {(result.failed ?? []).map((failure, index) => (
                <p key={`failed-${failure.row}-${index}`} className="mz-field__error">
                  {t('imports:row_label', { row: failure.row })} — {t(failure.message_key, failure.params)}
                </p>
              ))}

              {result.created === undefined ? (
                <Button
                  block
                  disabled={result.ready === 0}
                  loading={send.isPending && send.variables === 'commit'}
                  onClick={() => send.mutate('commit')}
                >
                  {result.ready === 0
                    ? t('imports:nothing_ready')
                    : t('imports:commit', { count: result.ready })}
                </Button>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>
    </AppShell>
  );
}
