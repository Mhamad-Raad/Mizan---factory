type Translate = (key: string, options?: Record<string, unknown>) => string;
type FormatNumber = (value: number) => string;

/**
 * The record's name in the reader's language. The API stores an English label ("Order #1014",
 * "Material: Copper wire") because History is written once and read in three languages, so a
 * numbered record is named by its translated kind and its number, and a named one by its name
 * alone. Order numbers are identifiers: they never carry a thousands separator.
 */
export function recordName(entityType: string, label: string, t: Translate, number: FormatNumber): string {
  const numbered = label.match(/#\s*(\d+)\s*$/);
  if (numbered) return `${t(`history:entity.${entityType}`, { defaultValue: entityType })} #${number(Number(numbered[1]))}`;
  const named = label.match(/^[A-Za-z ]+:\s*(.+)$/);
  return named?.[1] ?? label;
}

/**
 * A note as the reader should see it. Most notes are what somebody typed and are shown as they
 * are; the few the system writes itself for broken goods — kept on ledger rows that can never be
 * rewritten — are read in the reader's language instead of the English they were stored in.
 */
export function readNote(note: string, t: Translate, number: FormatNumber): string {
  const broken = note.match(/^Broken #(\d+)( paid back)?$/);
  if (!broken) return note;
  const name = `${t('history:entity.damage')} #${number(Number(broken[1]))}`;
  return broken[2] ? t('damages:paid_back_note', { name }) : name;
}
