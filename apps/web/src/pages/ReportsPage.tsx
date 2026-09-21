import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '@mizan/ui';
import { AppShell } from '../components/AppShell.js';
import { usePermission } from '../lib/store.js';

/** One card per report, with the one line that says what it contains (FR-1001). */
export const REPORTS = [
  { key: 'sales', path: '/reports/sales', flag: null },
  { key: 'purchases', path: '/reports/purchases', flag: null },
  { key: 'profit', path: '/reports/profit', flag: 'fields.see_profit' },
  { key: 'stock', path: '/reports/stock', flag: null },
  { key: 'receivables', path: '/reports/receivables', flag: 'fields.see_customer_balances' },
  { key: 'payables', path: '/reports/payables', flag: 'fields.see_company_balances' },
  { key: 'damage', path: '/reports/damage', flag: null },
  { key: 'employee_activity', path: '/reports/employee-activity', flag: null },
  // Proposed — not requested (FR-1013): the owner's nightly question.
  { key: 'cash_up', path: '/reports/cash-up', flag: null },
] as const;

/**
 * The Reports hub (FR-1001, spec 3.3): a card per report with its one-line description. A
 * report the caller's flags do not reach is absent rather than a locked door — the API would
 * refuse it, and offering it would be a promise the system cannot keep (FR-104).
 */
export function ReportsPage() {
  const { t } = useTranslation();
  const maySeeProfit = usePermission('fields.see_profit');
  const maySeeCustomerBalances = usePermission('fields.see_customer_balances');
  const maySeeCompanyBalances = usePermission('fields.see_company_balances');

  const allowed = REPORTS.filter((report) => {
    if (report.flag === 'fields.see_profit') return maySeeProfit;
    if (report.flag === 'fields.see_customer_balances') return maySeeCustomerBalances;
    if (report.flag === 'fields.see_company_balances') return maySeeCompanyBalances;
    return true;
  });

  return (
    <AppShell title={t('reports:title')}>
      <div className="mz-stack">
        <p className="mz-caption">{t('reports:hub_hint')}</p>
        {allowed.map((report) => (
          <Card key={report.key}>
            <Link to={report.path} className="mz-list__item mz-list__item--interactive mz-card-link">
              <span className="mz-list__body">
                <span className="mz-list__title">{t(`reports:${report.key}`)}</span>
                <span className="mz-caption">{t(`reports:${report.key}_hint`)}</span>
              </span>
              <span className="mz-list__end">{t('reports:open')}</span>
            </Link>
          </Card>
        ))}
      </div>
    </AppShell>
  );
}
