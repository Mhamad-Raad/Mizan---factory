import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Card } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { useKeepPageInRange, usePaging } from '../lib/paging.js';
import { usePermission } from '../lib/store.js';
import { DamageTable } from './DamageTable.js';
import { Pager } from './Pager.js';
import { QueryStates } from './states.js';
import type { DamageRow } from '../pages/DamagesPage.js';

/**
 * The broken goods of one order or one purchase, listed on its own page (D-094) rather than behind
 * a button to the Broken goods list: every record linked to it, voided ones included and marked,
 * newest first, a page at a time with its own place in the address. Only for a reader who may see
 * broken goods.
 */
export function LinkedDamages({ link }: { link: { order_id: string } | { purchase_id: string } }) {
  const { t } = useTranslation();
  const mayView = usePermission('damages.view');
  const [key, id] = 'order_id' in link ? ['order_id', link.order_id] : ['purchase_id', link.purchase_id];
  const paging = usePaging({ storageKey: 'linked-damages', prefix: 'damages_' });
  const damages = useQuery({
    queryKey: ['damages', 'linked', key, id, paging.page, paging.pageSize],
    queryFn: () =>
      apiRequest<{ items: DamageRow[]; total: number }>(`/damages?${key}=${id}&include_void=true&${paging.query}`),
    enabled: mayView,
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, damages);

  if (!mayView) return null;
  const rows = damages.data?.items ?? [];
  return (
    <Card>
      <div className="mz-stack">
        <h3 className="mz-heading">{t('glossary:damaged_items')}</h3>
        <QueryStates
          query={damages}
          isEmpty={rows.length === 0}
          emptyTitle={t('order_id' in link ? 'damages:none_on_order' : 'damages:none_on_purchase')}
          skeletonLines={2}
        >
          <div className="mz-stack">
            <DamageTable rows={rows} />
            <Pager
              page={paging.page}
              pageSize={paging.pageSize}
              total={damages.data?.total ?? 0}
              onPage={paging.setPage}
              onPageSize={paging.setPageSize}
            />
          </div>
        </QueryStates>
      </div>
    </Card>
  );
}
