import { useTranslation } from 'react-i18next';
import { Chip } from '@mizan/ui';
import { DataList } from './DataList.js';
import type { Column } from './DataList.js';
import { DualAmount } from './DualAmount.js';
import { CompensationChip } from './chips.js';
import { quantityText } from '../lib/quantity.js';
import { useFormatter } from '../lib/store.js';
import type { DamageRow } from '../pages/DamagesPage.js';

/**
 * Broken goods as rows (FR-807, D-062): a table on a desktop and a card each on a phone — the
 * Broken goods page and the broken goods of one order or purchase (D-094) draw them alike. Values
 * only for those allowed to see bought prices; quantities always.
 */
export function DamageTable({ rows }: { rows: readonly DamageRow[] }) {
  const { t } = useTranslation();
  const formatter = useFormatter();

  const whoOf = (damage: DamageRow) =>
    damage.attribution === 'company' && damage.company_name ? (
      <bdi>{damage.company_name}</bdi>
    ) : (
      <span className="mz-muted">{t('damages:ours_label')}</span>
    );

  const value = (damage: DamageRow) =>
    damage.cost && damage.cost.est_value_iqd !== null ? (
      <DualAmount amount_iqd={damage.cost.est_value_iqd} amount_usd_cents={damage.cost.est_value_usd_cents ?? 0} />
    ) : (
      <span className="mz-muted">—</span>
    );

  const statusOf = (damage: DamageRow) => (
    <span className="mz-rowcard__chips">
      <CompensationChip compensation={damage.compensation} />
      {damage.doc_status === 'void' ? (
        <Chip tone="danger" icon="close">
          {t('glossary:void')}
        </Chip>
      ) : null}
    </span>
  );

  const columns: Column<DamageRow>[] = [
    {
      header: t('common:number_column'),
      cell: (damage) => (
        <span className="mz-cell__body">
          <strong>{t('damages:number', { number: formatter.identifier(damage.number) })}</strong>
          <span className="mz-caption">{formatter.date(damage.damage_date)}</span>
        </span>
      ),
    },
    {
      header: t('damages:material_column'),
      cell: (damage) => (
        <span className="mz-cell__body">
          <bdi>{damage.item_name}</bdi>
          <span className="mz-caption" data-tabular>
            {quantityText(damage, formatter, t)}
          </span>
        </span>
      ),
    },
    { header: t('damages:who_column'), cell: whoOf },
    { header: t('common:status'), cell: statusOf },
    {
      header: t('glossary:done_by'),
      secondary: true,
      cell: (damage) =>
        damage.acting_user_name ? <bdi>{damage.acting_user_name}</bdi> : <span className="mz-muted">—</span>,
    },
    { header: t('damages:value_column'), numeric: true, cell: value },
  ];

  return (
    <DataList
      rows={rows}
      rowKey={(damage) => damage.id}
      href={(damage) => `/damages/${damage.id}`}
      columns={columns}
      card={(damage) => (
        <span className="mz-rowcard">
          <span className="mz-rowcard__head">
            <span className="mz-list__title">
              <bdi>{damage.item_name}</bdi>
            </span>
            {statusOf(damage)}
          </span>
          <span className="mz-caption" data-tabular>
            {t('damages:number', { number: formatter.identifier(damage.number) })} ·{' '}
            {quantityText(damage, formatter, t)} · {formatter.date(damage.damage_date)}
          </span>
          {damage.reason ? (
            <span className="mz-caption">
              <bdi>{damage.reason}</bdi>
            </span>
          ) : null}
          <span className="mz-rowcard__foot">
            <span className="mz-caption">{whoOf(damage)}</span>
            {value(damage)}
          </span>
        </span>
      )}
    />
  );
}
