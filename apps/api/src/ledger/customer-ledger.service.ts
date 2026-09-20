import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AccountLedgerService } from './account-ledger.service.js';
import type { LedgerAccount } from './account-ledger.service.js';
import type { LedgerShape } from './account-ledger.store.js';

/** The customer side of the shared writer: `customer_ledger`, pointing at orders (2.4.1). */
@Injectable()
export class CustomerLedgerService extends AccountLedgerService {
  protected readonly shape: LedgerShape = {
    table: 'customer_ledger',
    ownerColumn: 'customer_id',
    entryTypeEnum: 'customer_entry_type',
    documentColumn: 'order_id',
    ownerTable: 'customers',
  };

  /**
   * Declared explicitly, not inherited: Nest reads constructor metadata from the class it is
   * asked to build, and a subclass without a constructor of its own carries none — so the
   * dependency would arrive as `undefined`.
   */
  constructor(audit: AuditService) {
    super(audit);
  }

  protected readonly entityType = 'customer' as const;

  protected label(account: LedgerAccount): string {
    return `Customer: ${account.name}`;
  }
}

/** The rows an order owns: reversed on an edit or a void, unlike the payments against it. */
export const ORDER_DOCUMENT_TYPES = ['order', 'cash_settlement'] as const;

export type LedgerCustomer = LedgerAccount;
