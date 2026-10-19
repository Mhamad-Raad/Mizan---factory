import { useBusiness } from '../../lib/business.js';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Currency } from '@mizan/money';
import { DualAmount } from '../DualAmount.js';
import { useFormatter } from '../../lib/store.js';
import { customerName } from '../../lib/customers.js';
import { quantityText } from '../../lib/quantity.js';
import { readNote } from '../../lib/record-names.js';
import { bothOf } from '../../lib/money.js';
import { entryTitle } from '../../lib/entry-title.js';
import type {
  OrderReceiptData,
  PrintData,
  PurchaseReceiptData,
  StatementData,
  StatementSection,
  VoucherData,
} from './load.js';

/**
 * The printed documents (D-086). Each is a sheet of paper of its own — a header saying who issued
 * it and what it is, who it is about, the figures, and a footer with the rate and the day it was
 * printed — drawn black on white by the print stylesheet and in the page's own direction, so a
 * Kurdish receipt reads right to left like the screen it came from.
 */
export function PrintedDocument({ data }: { data: PrintData }) {
  switch (data.kind) {
    case 'order':
      return <OrderReceipt data={data} />;
    case 'purchase':
      return <PurchaseReceipt data={data} />;
    case 'voucher':
      return <PaymentVoucher data={data} />;
    case 'statement':
      return <AccountStatement data={data} />;
  }
}

/** Who issued it, and what this document is. */
function DocumentHead({
  type,
  title,
  date,
}: {
  type: string;
  title: ReactNode;
  date?: string | null;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  // The business's own name, phone, address and logo, as an admin set them (D-108); the product's
  // name until a name is set.
  const business = useBusiness();
  return (
    <header className="mz-invoice__head">
      <div
        className={
          business.logo ? 'mz-invoice__brand mz-invoice__brand--logo' : 'mz-invoice__brand'
        }
      >
        {business.logo ? <img className="mz-invoice__logo" src={business.logo} alt="" /> : null}
        <div className="mz-invoice__brand">
          <strong className="mz-invoice__name">
            <bdi>{business.name ?? t('common:app_name')}</bdi>
          </strong>
          {business.name ? null : (
            <span className="mz-invoice__muted">{t('common:app_tagline')}</span>
          )}
          {/* The phone and the address on one line under the name, as in the chosen design (D-110). */}
          {business.phone || business.address ? (
            <span className="mz-invoice__muted">
              {business.phone ? <bdi dir="ltr">{business.phone}</bdi> : null}
              {business.phone && business.address ? ' · ' : null}
              {business.address ? <bdi>{business.address}</bdi> : null}
            </span>
          ) : null}
        </div>
      </div>
      <div className="mz-invoice__doc">
        <span className="mz-invoice__doctype">{type}</span>
        <strong>{title}</strong>
        {date ? <span className="mz-invoice__muted">{formatter.date(date)}</span> : null}
      </div>
    </header>
  );
}

/** The rate the document was valued at, and the day it was printed. */
function DocumentFoot({ rate, closing }: { rate?: string | null; closing?: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  return (
    <footer className="mz-invoice__foot">
      {rate ? <span>{t('common:rate_used', { rate: formatter.rate(rate) })}</span> : <span />}
      <span>
        {closing ? `${closing} · ` : ''}
        {t('orders:printed_on', { date: formatter.date(formatter.today()) })}
      </span>
    </footer>
  );
}

/** A document voided since: said once, at the top, in words. */
function VoidBanner({ reason }: { reason: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="mz-invoice__void" role="note">
      <strong>{t('print:void_stamp')}</strong>
      {reason ? (
        <span>
          {' · '}
          <bdi>{reason}</bdi>
        </span>
      ) : null}
    </div>
  );
}

/** One titled card of who the document is about (D-110). */
function Party({ label, name, lines }: { label: string; name: ReactNode; lines?: ReactNode[] }) {
  return (
    <div className="mz-invoice__party">
      <span className="mz-invoice__label">{label}</span>
      <strong>{name}</strong>
      {(lines ?? []).filter(Boolean).map((line, index) => (
        <span key={index} className="mz-invoice__muted">
          {line}
        </span>
      ))}
    </div>
  );
}

function TotalRow({
  label,
  children,
  grand,
}: {
  label: string;
  children: ReactNode;
  grand?: boolean;
}) {
  return (
    <div
      className={
        grand ? 'mz-invoice__total-row mz-invoice__total-row--grand' : 'mz-invoice__total-row'
      }
    >
      <span>{label}</span>
      {grand ? <strong>{children}</strong> : children}
    </div>
  );
}

/** One of a sale's figures of what is still owed; `strong` is the one in the business's colour. */
function Figure({
  label,
  amount,
  primary,
  rate,
  strong,
}: {
  label: string;
  amount: number;
  primary: Currency;
  rate: string;
  strong?: boolean;
}) {
  return (
    <div
      className={strong ? 'mz-invoice__figure mz-invoice__figure--strong' : 'mz-invoice__figure'}
    >
      <span>{label}</span>
      <strong>
        <DualAmount {...bothOf(amount, primary, rate)} primary={primary} kind="derived" />
      </strong>
    </div>
  );
}

/** Two lines to sign on, for a document money changed hands over. */
function Signatures({ left, right }: { left: string; right: string }) {
  return (
    <div className="mz-invoice__signatures">
      <span>{left}</span>
      <span>{right}</span>
    </div>
  );
}

// ─────────────────────────────────────── an order ───────────────────────────────────────

/** An order's receipt (FR-613): who it is for, the lines, the money, and what is still owed. */
function OrderReceipt({ data }: { data: OrderReceiptData }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const { order, customer, driver } = data;
  const primary = customer.settlement_currency;
  const earlier = data.earlier_owing ?? null;
  const earlierOwed = earlier?.remaining ?? 0;
  const owesNow = Math.max(order.remaining, 0);
  // The account after this order, and what of it was owed before this order (D-110).
  const balance = customer.is_system ? null : data.balance_after;
  const before = balance === null ? 0 : balance - owesNow;
  // What was paid against this order: its total less what it still owes, in the account's currency.
  const settlementTotal = primary === 'IQD' ? order.total_iqd : order.total_usd_cents;
  const paid = order.doc_status === 'active' ? Math.max(settlementTotal - owesNow, 0) : 0;
  const subtotalIqd = order.lines.reduce((sum, line) => sum + line.line_total_iqd, 0);
  const subtotalUsd = order.lines.reduce((sum, line) => sum + line.line_total_usd_cents, 0);

  return (
    <div className="mz-invoice">
      <DocumentHead
        type={t('print:sale_receipt')}
        title={`#${formatter.identifier(order.number)}`}
        date={order.order_date}
      />
      {order.doc_status === 'void' ? <VoidBanner reason={order.void_reason} /> : null}

      <div className="mz-invoice__parties">
        <Party
          label={t('glossary:customer')}
          name={
            <bdi>{customerName({ name: customer.name, is_system: customer.is_system }, t)}</bdi>
          }
          lines={[customer.phone ? <bdi dir="ltr">{customer.phone}</bdi> : null]}
        />
        {/* The driver in a card of their own, with the car the goods went in (D-105, D-110). */}
        {driver ? (
          <Party
            label={t('glossary:driver')}
            name={<bdi>{driver.name}</bdi>}
            lines={[
              driver.car_number ? <bdi>{driver.car_number}</bdi> : null,
              driver.phone ? <bdi dir="ltr">{driver.phone}</bdi> : null,
            ]}
          />
        ) : null}
        <Party
          label={t('print:payment')}
          name={t(`glossary:${order.payment_type}`)}
          lines={[
            order.acting_user_name ? `${t('glossary:done_by')}: ${order.acting_user_name}` : null,
          ]}
        />
      </div>

      <table className="mz-invoice__table">
        <thead>
          <tr>
            <th>{t('glossary:item')}</th>
            <th className="mz-invoice__num">{t('glossary:quantity')}</th>
            <th className="mz-invoice__num">{t('glossary:unit_price')}</th>
            {/* A line's own word: in Kurdish "amount" and "quantity" are both بڕ in the glossary. */}
            <th className="mz-invoice__num">{t('print:line_amount')}</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <tr key={line.id}>
              <td>
                <bdi>{line.item_name}</bdi>
              </td>
              <td className="mz-invoice__num" data-tabular>
                {quantityText(line, formatter, t)}
              </td>
              <td className="mz-invoice__num">
                <DualAmount
                  amount_iqd={line.unit_price_iqd}
                  amount_usd_cents={line.unit_price_usd_cents}
                  primary={line.price_entered_currency}
                />
              </td>
              <td className="mz-invoice__num">
                <DualAmount
                  amount_iqd={line.line_total_iqd}
                  amount_usd_cents={line.line_total_usd_cents}
                  primary={primary}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mz-invoice__totals">
        <TotalRow label={t('orders:subtotal')}>
          <DualAmount amount_iqd={subtotalIqd} amount_usd_cents={subtotalUsd} primary={primary} />
        </TotalRow>
        {order.discount_iqd > 0 ? (
          <TotalRow label={t('glossary:discount')}>
            <span>
              −
              <DualAmount
                amount_iqd={order.discount_iqd}
                amount_usd_cents={order.discount_usd_cents}
                primary={primary}
              />
            </span>
          </TotalRow>
        ) : null}
        {(order.rounding_iqd ?? 0) > 0 ? (
          <TotalRow label={t('orders:rounding')}>
            <span>
              +
              <DualAmount
                amount_iqd={order.rounding_iqd ?? 0}
                amount_usd_cents={order.rounding_usd_cents ?? 0}
                primary={primary}
              />
            </span>
          </TotalRow>
        ) : null}
        <TotalRow label={t('glossary:total')} grand>
          <DualAmount
            amount_iqd={order.total_iqd}
            amount_usd_cents={order.total_usd_cents}
            primary={primary}
          />
        </TotalRow>
        {paid > 0 ? (
          <TotalRow label={t('print:paid_amount')}>
            <span>
              −
              <DualAmount
                {...bothOf(paid, primary, order.rate_iqd_per_usd)}
                primary={primary}
                kind="derived"
              />
            </span>
          </TotalRow>
        ) : null}
      </div>

      {/* What is still owed, in figures (D-109, D-110): this order, the earlier ones — counted, not
          listed, as the business chose — and the two added, in the business's colour. Their
          account is said as well when it differs: an opening debt, a credit, a payment not made
          against an order. Not on a void order: it owes nothing. */}
      {order.doc_status === 'active' ? (
        <div className="mz-invoice__figures">
          {/* Always three, as in the chosen design (D-110): what is left on this order, what was
              owed before it, and what they owe now — the account itself, so the red figure is the
              truth even with an opening debt, a credit or a payment not made against an order.
              "Before" names the earlier orders when they are the whole of it. */}
          {balance !== null ? (
            <>
              <Figure
                label={t('print:this_order_owes')}
                amount={owesNow}
                primary={primary}
                rate={order.rate_iqd_per_usd}
              />
              <Figure
                label={
                  before < 0
                    ? t('print:credit_before')
                    : before === earlierOwed && (earlier?.count ?? 0) > 0
                      ? t('print:earlier_owe', { count: earlier?.count ?? 0 })
                      : t('print:owed_before')
                }
                amount={Math.abs(before)}
                primary={primary}
                rate={order.rate_iqd_per_usd}
              />
              <Figure
                label={balance >= 0 ? t('print:total_owed') : balanceLabel('sales', balance, t)}
                amount={Math.abs(balance)}
                primary={primary}
                rate={order.rate_iqd_per_usd}
                strong
              />
            </>
          ) : (
            // Whoever may not see balances, and the walk-in, see what is left on this order alone.
            <Figure
              label={t('orders:remaining')}
              amount={owesNow}
              primary={primary}
              rate={order.rate_iqd_per_usd}
              strong
            />
          )}
        </div>
      ) : null}

      <DocumentFoot rate={order.rate_iqd_per_usd} closing={t('orders:thank_you')} />
    </div>
  );
}

// ─────────────────────────────────────── a purchase ───────────────────────────────────────

/**
 * A purchase's receipt (D-086): what we bought, from whom, what each line cost, and — for a
 * purchase from a company — what was paid and what we still owe on it, by the same oldest-first
 * reading as the purchase's own page.
 */
function PurchaseReceipt({ data }: { data: PurchaseReceiptData }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const { purchase, balance } = data;
  const primary: Currency = purchase.settlement_currency ?? 'IQD';
  const rate = purchase.rate_iqd_per_usd;
  const subtotalIqd = purchase.lines.reduce(
    (sum, line) => sum + (line.cost?.line_total_iqd ?? 0),
    0,
  );
  const subtotalUsd = purchase.lines.reduce(
    (sum, line) => sum + (line.cost?.line_total_usd_cents ?? 0),
    0,
  );
  const total = balance?.cost.total ?? null;
  const remaining = balance?.cost.remaining ?? null;
  const owedNow = balance?.account_owed ?? null;

  return (
    <div className="mz-invoice">
      <DocumentHead
        type={t('print:purchase_receipt')}
        title={`#${formatter.identifier(purchase.number)}`}
        date={purchase.purchase_date}
      />
      {purchase.doc_status === 'void' ? <VoidBanner reason={purchase.void_reason} /> : null}

      <div className="mz-invoice__parties">
        <Party
          label={t('print:bought_from')}
          name={
            purchase.company_name ? <bdi>{purchase.company_name}</bdi> : t('purchases:no_company')
          }
        />
        {/* Who brought it in, with the car (D-106), in a card of their own (D-110). */}
        {purchase.driver ? (
          <Party
            label={t('glossary:driver')}
            name={<bdi>{purchase.driver.name}</bdi>}
            lines={[
              purchase.driver.car_number ? <bdi>{purchase.driver.car_number}</bdi> : null,
              purchase.driver.phone ? <bdi dir="ltr">{purchase.driver.phone}</bdi> : null,
            ]}
          />
        ) : null}
        <Party
          label={t('glossary:done_by')}
          name={purchase.acting_user_name ?? '—'}
          lines={[purchase.notes ? <bdi>{purchase.notes}</bdi> : null]}
        />
      </div>

      <table className="mz-invoice__table">
        <thead>
          <tr>
            <th>{t('glossary:material')}</th>
            <th className="mz-invoice__num">{t('glossary:quantity')}</th>
            <th className="mz-invoice__num">{t('glossary:unit_price')}</th>
            {/* A line's own word: in Kurdish "amount" and "quantity" are both بڕ in the glossary. */}
            <th className="mz-invoice__num">{t('print:line_amount')}</th>
          </tr>
        </thead>
        <tbody>
          {purchase.lines.map((line) => (
            <tr key={line.id}>
              <td>
                <bdi>{line.item_name}</bdi>
              </td>
              <td className="mz-invoice__num" data-tabular>
                {quantityText(line, formatter, t)}
              </td>
              <td className="mz-invoice__num">
                {line.cost ? (
                  <DualAmount
                    amount_iqd={line.cost.unit_price_iqd}
                    amount_usd_cents={line.cost.unit_price_usd_cents}
                    primary={line.cost.price_entered_currency}
                  />
                ) : (
                  '—'
                )}
              </td>
              <td className="mz-invoice__num">
                {line.cost ? (
                  <DualAmount
                    amount_iqd={line.cost.line_total_iqd}
                    amount_usd_cents={line.cost.line_total_usd_cents}
                    primary={primary}
                  />
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {purchase.cost ? (
        <div className="mz-invoice__totals">
          {purchase.cost.discount_iqd > 0 ? (
            <>
              <TotalRow label={t('orders:subtotal')}>
                <DualAmount
                  amount_iqd={subtotalIqd}
                  amount_usd_cents={subtotalUsd}
                  primary={primary}
                />
              </TotalRow>
              <TotalRow label={t('glossary:discount')}>
                <span>
                  −
                  <DualAmount
                    amount_iqd={purchase.cost.discount_iqd}
                    amount_usd_cents={purchase.cost.discount_usd_cents}
                    primary={primary}
                  />
                </span>
              </TotalRow>
            </>
          ) : null}
          <TotalRow label={t('glossary:total')} grand>
            <DualAmount
              amount_iqd={purchase.cost.total_iqd}
              amount_usd_cents={purchase.cost.total_usd_cents}
              primary={primary}
            />
          </TotalRow>
          {total !== null &&
          remaining !== null &&
          purchase.doc_status === 'active' &&
          total - remaining > 0 ? (
            <TotalRow label={t('print:paid_amount')}>
              <span>
                −
                <DualAmount
                  {...bothOf(total - remaining, primary, rate)}
                  primary={primary}
                  kind="derived"
                />
              </span>
            </TotalRow>
          ) : null}
        </div>
      ) : null}

      {/* The three figures of a sale receipt, from our side (D-111): what is left to pay on this
          purchase, what we owed the company before it, and what we owe them now, in red — the
          company's account itself, so the red figure is the truth whatever else is on it. */}
      {remaining !== null && owedNow !== null && purchase.doc_status === 'active' ? (
        <div className="mz-invoice__figures">
          <Figure
            label={t('print:this_purchase_owes')}
            amount={remaining}
            primary={primary}
            rate={rate}
          />
          <Figure
            label={owedNow - remaining < 0 ? t('print:paid_ahead') : t('print:we_owed_before')}
            amount={Math.abs(owedNow - remaining)}
            primary={primary}
            rate={rate}
          />
          <Figure
            label={owedNow >= 0 ? t('print:we_owe_total') : balanceLabel('buying', owedNow, t)}
            amount={Math.abs(owedNow)}
            primary={primary}
            rate={rate}
            strong
          />
        </div>
      ) : null}

      {purchase.company_name ? (
        <Signatures left={t('print:sign_received_by')} right={t('print:sign_delivered_by')} />
      ) : null}
      <DocumentFoot rate={rate} />
    </div>
  );
}

// ─────────────────────────────────────── a voucher ───────────────────────────────────────

/**
 * One money row of an account, as a receipt (FR-614): a payment received from a company or made
 * to one, a credit, a refund, an adjustment. What it says about the balance after it depends on
 * the side: on the sales side it is what they still owe us, on the buying side what we still owe
 * them.
 */
function PaymentVoucher({ data }: { data: VoucherData }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const namespace = data.side === 'sales' ? 'customers' : 'companies';
  const primary: Currency = data.entered_currency ?? data.account.settlement_currency;
  const settlement = data.account.settlement_currency;
  const isPayment = data.entry_type === 'payment';
  // A payment is shown as the money that moved, never as a minus; other rows keep their sign.
  const magnitude = (value: number) => (isPayment ? Math.abs(value) : value);
  const type = isPayment
    ? t(data.side === 'sales' ? 'print:voucher_received' : 'print:voucher_paid')
    : t(`${namespace}:entry.${data.entry_type}`);

  return (
    <div className="mz-invoice">
      <DocumentHead
        type={type}
        title={
          data.voucher_number !== null
            ? t('customers:voucher_number', { number: formatter.identifier(data.voucher_number) })
            : t(`${namespace}:entry.${data.entry_type}`)
        }
        date={data.entry_date}
      />
      {data.is_cancelled ? <VoidBanner reason={t('print:cancelled_by_reversal')} /> : null}

      <div className="mz-invoice__parties">
        <Party
          label={t(
            isPayment
              ? data.side === 'sales'
                ? 'print:received_from'
                : 'print:paid_to'
              : 'glossary:company',
          )}
          name={<bdi>{data.account.name}</bdi>}
          lines={[data.account.phone ? <bdi dir="ltr">{data.account.phone}</bdi> : null]}
        />
        <Party
          label={t('glossary:done_by')}
          name={data.performed_by_name ?? '—'}
          lines={[
            data.method ? t(`print:method.${data.method}`, { defaultValue: data.method }) : null,
          ]}
        />
      </div>

      <div className="mz-invoice__amount">
        <span className="mz-invoice__label">{t('glossary:amount')}</span>
        <DualAmount
          amount_iqd={magnitude(data.amount_iqd)}
          amount_usd_cents={magnitude(data.amount_usd_cents)}
          primary={primary}
          size="large"
        />
      </div>

      {data.note ? (
        <p className="mz-invoice__note">
          <span className="mz-invoice__label">{t('common:note')}</span>{' '}
          <bdi>{readNote(data.note, t, formatter.identifier)}</bdi>
        </p>
      ) : null}

      <div className="mz-invoice__totals">
        <TotalRow label={balanceLabel(data.side, data.balance_after, t)} grand>
          <DualAmount
            {...bothOf(Math.abs(data.balance_after), settlement, data.rate_iqd_per_usd)}
            primary={settlement}
            kind="derived"
          />
        </TotalRow>
      </div>

      {isPayment ? (
        <Signatures
          left={t(data.side === 'sales' ? 'print:sign_received_by' : 'print:sign_paid_by')}
          right={t(data.side === 'sales' ? 'print:sign_paid_by' : 'print:sign_received_by')}
        />
      ) : null}
      <DocumentFoot rate={data.rate_iqd_per_usd} />
    </div>
  );
}

/** What a balance after a row means, on each side and for each sign. */
function balanceLabel(
  side: VoucherData['side'],
  balance: number,
  t: (key: string) => string,
): string {
  if (balance === 0) return t('companies:settled');
  if (side === 'sales') return t(balance > 0 ? 'companies:they_owe_us' : 'customers:in_credit');
  return t(balance > 0 ? 'companies:we_owe_them' : 'print:paid_ahead');
}

// ─────────────────────────────────────── a statement ───────────────────────────────────────

/**
 * An account's transactions over a period (FR-615, D-086): a section per side, each opening with
 * what stood before the period and closing with what stands at its end, every row in between with
 * its running balance — the same figures the account's page shows, in the same order.
 */
function AccountStatement({ data }: { data: StatementData }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const account = data.sections[0]?.account;
  const sales = data.sections.find((section) => section.side === 'sales');
  const buying = data.sections.find((section) => section.side === 'buying');

  return (
    <div className="mz-invoice">
      <DocumentHead
        type={t('glossary:statement')}
        title={account ? <bdi>{account.name}</bdi> : ''}
        date={null}
      />
      <div className="mz-invoice__parties">
        <Party
          label={t('print:period')}
          name={t('companies:statement_range', {
            from: formatter.date(data.from),
            to: formatter.date(data.to),
          })}
          lines={[account?.phone ? <bdi dir="ltr">{account.phone}</bdi> : null]}
        />
      </div>

      {data.sections.map((section) => (
        <StatementTable key={section.side} section={section} />
      ))}

      {/* Both sides at the period's end, and what they come to together (D-054). */}
      {sales && buying ? (
        <div className="mz-invoice__totals mz-invoice__totals--spaced">
          <TotalRow label={t('companies:they_owe_us')}>
            <span data-tabular>
              {formatter.money(sales.closing_balance, sales.account.settlement_currency)}
            </span>
          </TotalRow>
          <TotalRow label={t('companies:we_owe_them')}>
            <span data-tabular>
              {formatter.money(buying.closing_balance, buying.account.settlement_currency)}
            </span>
          </TotalRow>
          <TotalRow label={netLabel(sales.closing_balance - buying.closing_balance, t)} grand>
            <span data-tabular>
              {formatter.money(
                Math.abs(sales.closing_balance - buying.closing_balance),
                sales.account.settlement_currency,
              )}
            </span>
          </TotalRow>
        </div>
      ) : null}

      <DocumentFoot />
    </div>
  );
}

function netLabel(net: number, t: (key: string) => string): string {
  if (net === 0) return t('companies:settled');
  return t(net > 0 ? 'print:net_they_owe_us' : 'print:net_we_owe_them');
}

function StatementTable({ section }: { section: StatementSection }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const currency = section.account.settlement_currency;
  const namespace = section.side === 'sales' ? 'customers' : 'companies';
  const money = (value: number) => formatter.money(value, currency);

  return (
    <section className="mz-invoice__section">
      <h3 className="mz-invoice__section-title">
        {t(section.side === 'sales' ? 'print:section_sales' : 'print:section_buying')}
      </h3>
      {section.has_more ? (
        <p className="mz-invoice__muted">
          {t('common:statement_capped', { shown: section.items.length, total: section.item_count })}
        </p>
      ) : null}
      <table className="mz-invoice__table">
        <thead>
          <tr>
            <th>{t('common:date')}</th>
            <th>{t('customers:ledger_entry')}</th>
            <th className="mz-invoice__num">{t('glossary:amount')}</th>
            <th className="mz-invoice__num">{t('customers:balance_after')}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="mz-invoice__row--quiet">
            <td />
            <td>{t('glossary:opening_balance')}</td>
            <td />
            <td className="mz-invoice__num" data-tabular>
              {money(section.opening_balance)}
            </td>
          </tr>
          {section.items.map((row) => (
            <tr key={row.entry_id}>
              <td data-tabular>{formatter.date(row.entry_date)}</td>
              <td>
                {entryTitle(row, namespace, t, formatter.identifier)}
                {row.voucher_number !== null
                  ? ` · ${t('customers:voucher_number', { number: formatter.identifier(row.voucher_number) })}`
                  : ''}
                {row.note ? (
                  <span className="mz-invoice__muted" style={{ display: 'block' }}>
                    <bdi>{readNote(row.note, t, formatter.identifier)}</bdi>
                  </span>
                ) : null}
              </td>
              <td className="mz-invoice__num">
                <DualAmount
                  amount_iqd={row.amount_iqd}
                  amount_usd_cents={row.amount_usd_cents}
                  primary={currency}
                />
              </td>
              <td className="mz-invoice__num" data-tabular>
                {row.kind === 'rebase' ? '' : money(row.balance_after)}
              </td>
            </tr>
          ))}
          <tr className="mz-invoice__row--strong">
            <td />
            <td>
              {t(section.side === 'sales' ? 'companies:they_owe_us' : 'companies:we_owe_them')}
            </td>
            <td />
            <td className="mz-invoice__num" data-tabular>
              {money(section.closing_balance)}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
