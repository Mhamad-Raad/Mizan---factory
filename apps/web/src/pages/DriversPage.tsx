import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, TextField } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { useDebouncedValue } from '../lib/debounce.js';
import { useKeepPageInRange, usePaging } from '../lib/paging.js';
import { useFormatter, usePermission } from '../lib/store.js';
import { driverCaption } from '../lib/drivers.js';
import type { DriverRow } from '../lib/drivers.js';
import { DataList } from '../components/DataList.js';
import { DriverSheet } from '../components/DriverSheet.js';
import { FilterChip } from '../components/FilterChip.js';
import { InactiveChip } from '../components/chips.js';
import { Pager } from '../components/Pager.js';
import { QueryStates } from '../components/states.js';
import { SavedToast } from '../components/SavedToast.js';
import type { SavedNotice } from '../components/SavedToast.js';

/**
 * Drivers (D-105): who takes the orders to the companies. A search over the name, the phone and
 * the car number, the deactivated ones on their own filter, and "New driver"; a row opens the
 * driver's page — their details and every order they took.
 */
export function DriversPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const mayCreate = usePermission('drivers.create');
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search);
  const [inactive, setInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<SavedNotice | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const paging = usePaging({ storageKey: 'drivers', resetOn: [query, inactive] });
  const drivers = useQuery({
    queryKey: ['drivers', query, inactive, paging.page, paging.pageSize],
    queryFn: () => {
      const params = new URLSearchParams({ q: query, status: inactive ? 'inactive' : 'active' });
      return apiRequest<{ items: DriverRow[]; total: number }>(
        `/drivers?${params.toString()}&${paging.query}`,
      );
    },
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, drivers);
  const refreshing = drivers.isFetching && drivers.isPlaceholderData;
  const rows = drivers.data?.items ?? [];

  usePageTitle(t('drivers:title'));

  const lastOrder = (row: DriverRow) =>
    row.last_order_date ? (
      <span data-tabular>{formatter.date(row.last_order_date)}</span>
    ) : (
      <span className="mz-muted">{t('drivers:no_orders_yet')}</span>
    );

  const newButton = mayCreate ? (
    <Button icon="plus" onClick={() => setCreating(true)}>
      {t('drivers:new_driver')}
    </Button>
  ) : null;

  return (
    <div className="mz-stack">
      <div className="mz-toolbar">
        <div className="mz-toolbar__filters">
          <div className="mz-toolbar__search">
            <TextField
              label={t('common:search')}
              placeholder={t('drivers:search_placeholder')}
              value={search}
              type="search"
              inputMode="search"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <FilterChip active={inactive} onClick={() => setInactive(!inactive)}>
            {t('common:deactivated')}
          </FilterChip>
        </div>
        {newButton}
      </div>

      <QueryStates
        query={drivers}
        isEmpty={rows.length === 0}
        emptyTitle={
          query
            ? t('materials:empty_search', { query })
            : inactive
              ? t('drivers:empty_inactive')
              : t('drivers:empty')
        }
        emptyAction={!query && !inactive ? newButton : undefined}
      >
        <div
          className="mz-refreshable"
          data-busy={refreshing ? 'true' : undefined}
          aria-busy={refreshing}
        >
          <DataList
            rows={rows}
            rowKey={(row) => row.id}
            href={(row) => `/drivers/${row.id}`}
            columns={[
              {
                header: t('drivers:name'),
                cell: (row) => (
                  <span className="mz-cell__body">
                    <strong>
                      <bdi>{row.name}</bdi>
                    </strong>
                    <InactiveChip row={row} />
                  </span>
                ),
              },
              {
                header: t('drivers:phone'),
                cell: (row) =>
                  row.phone ? (
                    <bdi dir="ltr">{row.phone}</bdi>
                  ) : (
                    <span className="mz-muted">—</span>
                  ),
              },
              {
                header: t('drivers:car_number'),
                cell: (row) =>
                  row.car_number ? (
                    <bdi>{row.car_number}</bdi>
                  ) : (
                    <span className="mz-muted">—</span>
                  ),
              },
              { header: t('drivers:last_order'), cell: lastOrder },
            ]}
            card={(row) => (
              <span className="mz-rowcard">
                <span className="mz-rowcard__head">
                  <span className="mz-list__title">
                    <bdi>{row.name}</bdi>
                  </span>
                  <InactiveChip row={row} />
                </span>
                {driverCaption(row) ? (
                  <span className="mz-caption">
                    <bdi>{driverCaption(row)}</bdi>
                  </span>
                ) : null}
                <span className="mz-caption">
                  {t('drivers:last_order')}: {lastOrder(row)}
                </span>
              </span>
            )}
          />
        </div>
        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          total={drivers.data?.total ?? 0}
          onPage={paging.setPage}
          onPageSize={paging.setPageSize}
        />
      </QueryStates>

      {creating ? (
        <DriverSheet
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            setNotice({ message: t('drivers:created') });
          }}
        />
      ) : null}
      {notice ? <SavedToast notice={notice} onDone={dismissNotice} /> : null}
    </div>
  );
}
