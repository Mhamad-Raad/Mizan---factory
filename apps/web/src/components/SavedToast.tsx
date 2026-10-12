import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Toast } from '@mizan/ui';
import { usePrint } from '../lib/print.js';
import type { PrintDocument } from '../lib/print.js';

/** What a page says after a write: the sentence, and the receipt it can print, if any. */
export interface SavedNotice {
  message: string;
  /** The receipt of what was just recorded (D-086): a payment's voucher, a purchase's receipt. */
  receipt?: PrintDocument | null;
}

/**
 * The toast after a save — "on that action, show a print receipt" (D-086). With a receipt, its
 * button prints it; without, it closes. Either way it goes by itself after a while, so a receipt
 * nobody wanted never sits on the screen.
 */
export function SavedToast({ notice, onDone }: { notice: SavedNotice; onDone: () => void }) {
  const { t } = useTranslation();
  const print = usePrint();
  useEffect(() => {
    const timer = window.setTimeout(onDone, 12_000);
    return () => window.clearTimeout(timer);
  }, [notice, onDone]);

  return (
    <Toast
      message={notice.message}
      actionLabel={notice.receipt ? t('print:print_receipt') : t('common:close')}
      onAction={() => {
        if (notice.receipt) print([notice.receipt]);
        onDone();
      }}
    />
  );
}

/** The voucher of the payment row an account write answered with, if it wrote one. */
export function paymentReceipt(
  side: 'sales' | 'buying',
  accountId: string,
  answer: unknown,
): PrintDocument | null {
  const rows = (Array.isArray(answer) ? answer : [answer]) as { entry_id?: string; entry_type?: string }[];
  const row = rows.find((candidate) => candidate?.entry_id && candidate.entry_type !== 'adjustment') ?? rows[0];
  return row?.entry_id ? { kind: 'voucher', side, accountId, entryId: row.entry_id } : null;
}
