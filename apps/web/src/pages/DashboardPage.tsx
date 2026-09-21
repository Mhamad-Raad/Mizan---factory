import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Card, Chip } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
import { useFormatter } from '../lib/store.js';

interface Tile {
  key: string;
  count?: number;
  amount_iqd?: number;
  amount_usd_cents?: number;
  cost?: { amount_iqd: number; amount_usd_cents: number } | null;
  detail?: string | null;
}

/** Where each tile leads, so a number is never a dead end (spec 3.3). */
const LINKS: Record<string, string> = {
  sales_today: '/orders',
  unpaid_orders: '/orders',
  purchases_today: '/purchases',
  we_owe_companies: '/companies?sort=balance',
  low_stock: '/materials',
  pending_returns: '/damages',
  my_actions_today: '/history',
};

/**
 * The dashboard (FR-1309, **Proposed — not requested**): today in tiles, two to a row at
 * 400 px, each linking to the list it summarises. A tile the caller's permissions do not reach
 * never arrives from the API, so there is nothing to hide here.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();

  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () =>
      apiRequest<{ date: string; tiles: Tile[]; rate: { rate_iqd_per_usd: string; is_stale: boolean } | null }>(
        '/dashboard',
      ),
  });

  const tiles = dashboard.data?.tiles ?? [];

  return (
    <AppShell title={t('dashboard:title')}>
      <div className="mz-stack">
        {/* Proposed — not requested (FR-1106): a rate nobody has touched skews every dollar. */}
        {dashboard.data?.rate?.is_stale ? (
          <div className="mz-warning" role="status">
            {t('settings:rate_stale', { rate: formatter.rate(dashboard.data.rate.rate_iqd_per_usd) })}
          </div>
        ) : null}

        <QueryStates query={dashboard} isEmpty={tiles.length === 0} emptyTitle={t('dashboard:empty')}>
          <div className="mz-tiles">
            {tiles.map((tile) => (
              <Card key={tile.key}>
                <Link to={LINKS[tile.key] ?? '/'} className="mz-card-link">
                  <span className="mz-caption">{t(`dashboard:tile.${tile.key}`)}</span>
                  {tile.count !== undefined ? (
                    <span className="mz-title" data-tabular>
                      {formatter.number(tile.count)}
                    </span>
                  ) : null}
                  {tile.amount_iqd !== undefined ? (
                    <DualAmount amount_iqd={tile.amount_iqd} amount_usd_cents={tile.amount_usd_cents ?? 0} />
                  ) : null}
                  {tile.cost ? (
                    <DualAmount amount_iqd={tile.cost.amount_iqd} amount_usd_cents={tile.cost.amount_usd_cents} />
                  ) : null}
                  {tile.detail ? (
                    <Chip>{formatter.money(Number(tile.detail), 'IQD')}</Chip>
                  ) : null}
                </Link>
              </Card>
            ))}
          </div>
        </QueryStates>
      </div>
    </AppShell>
  );
}
