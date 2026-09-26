import { useTranslation } from 'react-i18next';
import { Icon } from '@mizan/ui';
import { DataList } from './DataList.js';
import type { Column } from './DataList.js';
import { DualAmount } from './DualAmount.js';
import { OrderStatusChip, PaymentTypeChip } from './chips.js';
import { customerName } from '../lib/customers.js';
import { useFormatter } from '../lib/store.js';
import type { OrderRow } from '../pages/OrdersPage.js';

/**
 * Orders as the Orders page shows them — a table on a desktop, a card per order on a phone —
 * so a business's Orders tab reads exactly like the list it is a slice of.
 *
 * `showCustomer` is off where every row is the same business: the column would repeat its name
 * down the page, so the column shows who recorded the sale instead.
 */
export function OrderTable({ rows, showCustomer = true }: { rows: readonly OrderRow[]; showCustomer?: boolean }) {
  const { t } = useTranslation();
  const formatter = useFormatter();

  const recordedBy = (order: OrderRow) =>
    order.acting_user_name ? (
      <span className="mz-caption" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        <Icon name="user" size={12} />
        <bdi>{order.acting_user_name}</bdi>
      </span>
    ) : null;

  const columns: Column<OrderRow>[] = [
    {
      // Order number over its date, so a row is anchored by what people call it.
      header: t('common:number_column'),
      cell: (order) => (
        <span className="mz-cell__body">
          <strong>{t('orders:number', { number: formatter.number(order.number) })}</strong>
          <span className="mz-caption">{formatter.date(order.order_date)}</span>
        </span>
      ),
    },
    showCustomer
      ? {
          // Customer, with who recorded the sale beneath it.
          header: t('glossary:customer'),
          cell: (order) => (
            <span className="mz-cell__body">
              <bdi>{customerName({ name: order.customer_name, is_system: order.customer_is_system }, t)}</bdi>
              {recordedBy(order)}
            </span>
          ),
        }
      : { header: t('glossary:done_by'), cell: (order) => recordedBy(order) ?? <span className="mz-muted">—</span> },
    {
      header: t('glossary:total'),
      numeric: true,
      cell: (order) => (
        <DualAmount amount_iqd={order.total_iqd} amount_usd_cents={order.total_usd_cents} primary={order.settlement_currency} />
      ),
    },
    {
      // What is still owed — the number an office actually chases.
      header: t('orders:remaining'),
      numeric: true,
      cell: (order) =>
        order.remaining > 0 ? (
          <span className="mz-owed" data-tabular>
            {formatter.money(order.remaining, order.settlement_currency)}
          </span>
        ) : (
          <span className="mz-muted">—</span>
        ),
    },
    {
      header: t('glossary:payment_type'),
      secondary: true,
      cell: (order) => <PaymentTypeChip type={order.payment_type} />,
    },
    { header: t('common:status'), cell: (order) => <OrderStatusChip status={order.status} /> },
  ];

  return (
    <DataList
      rows={rows}
      rowKey={(order) => order.id}
      href={(order) => `/orders/${order.id}`}
      columns={columns}
      card={(order) => (
        <span className="mz-rowcard">
          <span className="mz-rowcard__head">
            <span className="mz-list__title">{t('orders:number', { number: formatter.number(order.number) })}</span>
            <span className="mz-rowcard__chips">
              <PaymentTypeChip type={order.payment_type} />
              <OrderStatusChip status={order.status} />
            </span>
          </span>
          <span className="mz-caption">
            {showCustomer ? (
              <>
                <bdi>{customerName({ name: order.customer_name, is_system: order.customer_is_system }, t)}</bdi>
                {' · '}
              </>
            ) : null}
            {formatter.date(order.order_date)}
            {order.acting_user_name ? (
              <>
                {' · '}
                <bdi>{order.acting_user_name}</bdi>
              </>
            ) : null}
          </span>
          <span className="mz-rowcard__foot">
            <DualAmount amount_iqd={order.total_iqd} amount_usd_cents={order.total_usd_cents} primary={order.settlement_currency} />
            {order.remaining > 0 ? (
              <span className="mz-caption mz-owed" data-tabular>
                {t('orders:remaining')}: {formatter.money(order.remaining, order.settlement_currency)}
              </span>
            ) : null}
          </span>
        </span>
      )}
    />
  );
}
