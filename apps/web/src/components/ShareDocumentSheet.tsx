import { useTranslation } from 'react-i18next';
import { BottomSheet, Button } from '@mizan/ui';

export interface ShareDocumentSheetProps {
  title: string;
  open: boolean;
  onClose: () => void;
  /** The document as it is rendered on screen; what is shared is what you see. */
  children: React.ReactNode;
  /** Plain-text fallback for the share sheet and the clipboard. */
  text: string;
}

/**
 * Receipts, vouchers and statements (FR-613 to FR-615, Proposed — not requested).
 *
 * The figures come from the API and the page is rendered here, then handed to the phone's
 * share sheet — which on the factory floor means WhatsApp — or to the printer. There is no
 * server-side PDF engine to keep alive for the years this system has to run (D-014).
 */
export function ShareDocumentSheet({ title, open, onClose, children, text }: ShareDocumentSheetProps) {
  const { t } = useTranslation();

  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title, text });
        return;
      }
      await navigator.clipboard.writeText(text);
    } catch {
      // The user cancelled the share sheet, or the browser has neither: the document stays
      // on screen, which is still a document they can show or print.
    }
  };

  return (
    <BottomSheet title={title} open={open} onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        {children}
        <div className="mz-row" style={{ gap: 'var(--space-2)' }}>
          <Button onClick={() => void share()}>{t('common:share')}</Button>
          <Button variant="secondary" onClick={() => window.print()}>
            {t('common:print')}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
