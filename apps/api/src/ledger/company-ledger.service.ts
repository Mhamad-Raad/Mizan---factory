import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AccountLedgerService } from './account-ledger.service.js';
import type { LedgerAccount } from './account-ledger.service.js';
import type { LedgerShape } from './account-ledger.store.js';

/** The supplier side of the shared writer: `company_ledger`, pointing at purchases (2.4.1). */
@Injectable()
export class CompanyLedgerService extends AccountLedgerService {
  protected readonly shape: LedgerShape = {
    table: 'company_ledger',
    ownerColumn: 'company_id',
    entryTypeEnum: 'company_entry_type',
    documentColumn: 'purchase_id',
    // The buying side of a business: its owner is a `customers` row with `is_supplier` (D-054).
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

  protected readonly entityType = 'company' as const;

  protected label(account: LedgerAccount): string {
    return `Company: ${account.name}`;
  }
}

/**
 * The only row a purchase owns. A purchase has no settlement entry — the supplier side has no
 * "cash purchase" — so a void reverses this one row and leaves every payment standing (FR-405).
 */
export const PURCHASE_DOCUMENT_TYPES = ['purchase'] as const;

export type LedgerCompany = LedgerAccount;
