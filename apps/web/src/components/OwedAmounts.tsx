import { DualAmount } from './DualAmount.js';
import { useFormatter } from '../lib/store.js';
import { owedFigures } from '../lib/owed.js';
import { useGlobalRate } from '../lib/rates.js';

/**
 * What we owe the companies, as the Purchases page and Today show it (D-085): a figure per
 * currency the companies are kept in, each with the other side at today's rate when there is one.
 */
export function OwedAmounts({
  owed,
  size = 'normal',
}: {
  owed: { amount_iqd: number; amount_usd_cents: number };
  /** `large` on the two big cards of Buying & selling (D-089). */
  size?: 'normal' | 'large';
}) {
  const formatter = useFormatter();
  const { rate } = useGlobalRate();
  return (
    <>
      {owedFigures(owed, rate).map((figure) => (
        <span key={figure.primary} className="mz-owed" style={{ display: 'block' }}>
          {figure.pair ? (
            <DualAmount {...figure.pair} primary={figure.primary} kind="derived" size={size} />
          ) : (
            <span data-tabular>{formatter.money(figure.amount, figure.primary)}</span>
          )}
        </span>
      ))}
    </>
  );
}
