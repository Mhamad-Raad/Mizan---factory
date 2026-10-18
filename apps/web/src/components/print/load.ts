import type { Currency, Rate } from '@mizan/money';
import { apiRequest } from '../../lib/api.js';
import type { LedgerRow } from '../LedgerList.js';
import type { PurchaseDetail } from '../../lib/purchases.js';
import type { OrderDetail } from '../../pages/OrderFormPage.js';
import type { AccountSide, PrintDocument } from '../../lib/print.js';

/*
 * What each printed document is made of, fetched fresh at the moment of printing: a receipt
 * printed a year later says what the record says today — a voided buy prints as void.
 */

export interface OrderReceiptData {
  kind: 'order';
  order: OrderDetail;
  customer: { name: string; is_system: boolean; phone: string | null; settlement_currency: Currency };
  /** Who takes it (D-105), so whoever receives the goods knows who brought them. */
  driver?: { name: string; phone: string | null; car_number: string | null } | null;
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

export type PrintData =
  | OrderReceiptData
  | PurchaseReceiptData
  | VoucherData
  | StatementData;

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
  }
}

