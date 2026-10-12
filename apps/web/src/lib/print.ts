import { create } from 'zustand';

/**
 * Everything the system prints (D-086), named by what it is rather than how it is drawn: a
 * screen asks for documents, and the one print host fetches them, lays them out a page each and
 * opens the browser's print dialog — which is also where "Save as PDF" lives.
 */
export type PrintDocument =
  /** An order's receipt: who bought what, the money, what is still owed. */
  | { kind: 'order'; id: string }
  /** A purchase's receipt: what we bought from whom, what we paid, what we still owe on it. */
  | { kind: 'purchase'; id: string }
  /** One money row of an account: a payment either way, a credit, a refund, an adjustment. */
  | { kind: 'voucher'; side: AccountSide; accountId: string; entryId: string }
  /**
   * An account's transactions over a period, a section per side the reader may see — what they
   * owe us (sales) and what we owe them (buying).
   */
  | { kind: 'statement'; accountId: string; from: string; to: string; sides: AccountSide[] }
  /** The purchases list as filtered on screen: its query string (without paging) and its period. */
  | { kind: 'purchase_list'; query: string; from: string | null; to: string | null }
  /** The orders list as filtered on screen. */
  | { kind: 'order_list'; query: string; from: string | null; to: string | null };

/** `sales`: the customer ledger, what they owe us. `buying`: the company ledger, what we owe them. */
export type AccountSide = 'sales' | 'buying';

/**
 * How many receipts one print may carry. Each is its own request, and fifty pages is already a
 * stack of paper nobody checks; more than that is a statement, which prints as one document.
 */
export const PRINT_LIMIT = 50;

/** A list printout reads at most this many rows (ten pages of the API's largest page, D-058). */
export const PRINT_LIST_ROWS = 1000;

export interface PrintJob {
  id: number;
  documents: PrintDocument[];
}

interface PrintState {
  job: PrintJob | null;
  start: (documents: PrintDocument[]) => void;
  finish: (id: number) => void;
}

let nextJob = 1;

export const usePrintQueue = create<PrintState>((set) => ({
  job: null,
  // A new request replaces one still loading: the reader pressed Print again, or elsewhere.
  start: (documents) => set({ job: { id: nextJob++, documents: documents.slice(0, PRINT_LIMIT) } }),
  finish: (id) => set((state) => (state.job?.id === id ? { job: null } : state)),
}));

/** The function a screen calls to print: `print([{ kind: 'purchase', id }])`. */
export function usePrint(): (documents: PrintDocument[]) => void {
  return usePrintQueue((state) => state.start);
}

/**
 * The document a row of an account prints as. A row that *is* a document — the purchase on the
 * buying side, the order on the sales side — prints that document's receipt, which says far more
 * than "Purchase 150,000"; every other row prints as a voucher of its own.
 */
export function documentOfLedgerRow(
  side: AccountSide,
  accountId: string,
  row: { entry_id: string; entry_type: string; order_id?: string | null; purchase_id?: string | null },
): PrintDocument {
  if (side === 'buying' && row.entry_type === 'purchase' && row.purchase_id) {
    return { kind: 'purchase', id: row.purchase_id };
  }
  if (side === 'sales' && row.order_id && ORDER_ENTRY_TYPES.has(row.entry_type)) {
    return { kind: 'order', id: row.order_id };
  }
  return { kind: 'voucher', side, accountId, entryId: row.entry_id };
}

/** The sales-ledger rows an order owns: its charge, and the cash settlement of a cash order. */
const ORDER_ENTRY_TYPES = new Set(['order', 'cash_settlement']);
