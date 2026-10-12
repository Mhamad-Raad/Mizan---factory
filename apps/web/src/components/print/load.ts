import type { Currency, Rate } from '@mizan/money';
import { apiRequest } from '../../lib/api.js';
import type { LedgerRow } from '../LedgerList.js';
import type { PurchaseDetail, PurchaseRow } from '../../lib/purchases.js';
import type { OrderDetail } from '../../pages/OrderFormPage.js';
import type { OrderRow } from '../../pages/OrdersPage.js';
import { PRINT_LIST_ROWS } from '../../lib/print.js';
import type { AccountSide, PrintDocument } from '../../lib/print.js';

/*
 * What each printed document is made of, fetched fresh at the moment of printing: a receipt
 * printed a year later says what the record says today — a voided buy prints as void.
 */

export interface OrderReceiptData {
  kind: 'order';
  order: OrderDetail;
  customer: { name: string; is_system: boolean; phone: string | null; settlement_currency: Currency };
  balance_after: number | null;
}

export interface PurchaseReceiptData {
  kind: 'purchase';
  purchase: PurchaseDetail;
  /** What is paid and still owed on it; null without a company, or without the balances flag. */
  balance: { settlement_currency: Currency; cost: { total: number | null; remaining: number | null } } | null;
}

export interface VoucherData {
  kind: 'voucher';
  side: AccountSide;
  voucher_number: number | null;
  entry_type: string;
  entry_date: string;
  amount_iqd: number;
  amount_usd_cents: number;
  entered_currency: Currency | null;
  rate_iqd_per_usd: Rate;
  method: string | null;
  note: string | null;
  performed_by_name: string | null;
  balance_after: number;
  is_cancelled: boolean;
  account: { name: string; settlement_currency: Currency; phone: string | null };
}

export interface StatementSection {
  side: AccountSide;
  account: { name: string; settlement_currency: Currency; phone: string | null };
  from: string | null;
  to: string | null;
  opening_balance: number;
  closing_balance: number;
  items: (LedgerRow & { purchase_id?: string | null; purchase_number?: number | null; order_number?: number | null })[];
  item_count: number;
  has_more: boolean;
}

export interface StatementData {
  kind: 'statement';
  from: string;
  to: string;
  sections: StatementSection[];
}

export interface PurchaseListData {
  kind: 'purchase_list';
  from: string | null;
  to: string | null;
  rows: PurchaseRow[];
  total: number;
  totals: { buys: number; cost?: { total_iqd: number; total_usd_cents: number } } | null;
}

export interface OrderListData {
  kind: 'order_list';
  from: string | null;
  to: string | null;
  rows: OrderRow[];
  total: number;
  totals: { orders: number; total_iqd: number; total_usd_cents: number } | null;
}

export type PrintData =
  | OrderReceiptData
  | PurchaseReceiptData
  | VoucherData
  | StatementData
  | PurchaseListData
  | OrderListData;

/** The query key of one document, so two prints of the same thing never share stale data. */
export function printKey(document: PrintDocument): unknown[] {
  return ['print', document];
}

/**
 * Fetches one document. `may` answers whether the reader holds a flag, so nothing is asked for
 * that the API would refuse — a purchase's "still owed" needs the company-balances flag.
 */
export async function loadDocument(document: PrintDocument, may: (permission: string) => boolean): Promise<PrintData> {
  switch (document.kind) {
    case 'order': {
      const data = await apiRequest<Omit<OrderReceiptData, 'kind'>>(`/orders/${document.id}/receipt`);
      return { kind: 'order', ...data };
    }
    case 'purchase': {
      const purchase = await apiRequest<PurchaseDetail>(`/purchases/${document.id}`);
      const balance =
        purchase.company_id && may('fields.see_company_balances')
          ? await apiRequest<PurchaseReceiptData['balance']>(`/purchases/${document.id}/balance`)
          : null;
      return { kind: 'purchase', purchase, balance };
    }
    case 'voucher': {
      const path = document.side === 'sales' ? 'customers' : 'companies';
      const data = await apiRequest<Omit<VoucherData, 'kind' | 'side' | 'account'> & {
        customer?: VoucherData['account'];
        company?: VoucherData['account'];
      }>(`/${path}/${document.accountId}/ledger/${document.entryId}/voucher`);
      const account = data.customer ?? data.company;
      if (!account) throw new Error('voucher without an account');
      return { ...data, kind: 'voucher', side: document.side, account };
    }
    case 'statement': {
      const range = `from=${document.from}&to=${document.to}`;
      const sections = await Promise.all(
        document.sides.map(async (side): Promise<StatementSection> => {
          const path = side === 'sales' ? 'customers' : 'companies';
          const data = await apiRequest<Omit<StatementSection, 'side' | 'account'> & {
            customer?: StatementSection['account'];
            company?: StatementSection['account'];
          }>(`/${path}/${document.accountId}/statement?${range}`);
          const account = data.customer ?? data.company;
          if (!account) throw new Error('statement without an account');
          return { ...data, side, account };
        }),
      );
      return { kind: 'statement', from: document.from, to: document.to, sections };
    }
    case 'purchase_list': {
      const { rows, total, totals } = await allPages<PurchaseRow, PurchaseListData['totals']>(
        `/purchases?${document.query}`,
      );
      return { kind: 'purchase_list', from: document.from, to: document.to, rows, total, totals };
    }
    case 'order_list': {
      const { rows, total, totals } = await allPages<OrderRow, OrderListData['totals']>(`/orders?${document.query}`);
      return { kind: 'order_list', from: document.from, to: document.to, rows, total, totals };
    }
  }
}

/**
 * A list read a page of 100 at a time — the API's largest (D-058) — up to `PRINT_LIST_ROWS`. The
 * totals come with the first page and cover the whole filter, so a capped printout still adds up.
 */
async function allPages<Row, Totals>(path: string): Promise<{ rows: Row[]; total: number; totals: Totals | null }> {
  const rows: Row[] = [];
  let total = 0;
  let totals: Totals | null = null;
  for (let page = 1; rows.length < PRINT_LIST_ROWS; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const answer = await apiRequest<{ items: Row[]; total: number; totals?: Totals }>(
      `${path}${separator}page=${page}&page_size=100`,
    );
    if (page === 1) {
      total = answer.total;
      totals = answer.totals ?? null;
    }
    rows.push(...answer.items);
    if (answer.items.length < 100 || rows.length >= total) break;
  }
  return { rows: rows.slice(0, PRINT_LIST_ROWS), total, totals };
}
