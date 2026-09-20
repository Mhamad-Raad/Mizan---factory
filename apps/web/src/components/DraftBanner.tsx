import { useTranslation } from 'react-i18next';
import { Button } from '@mizan/ui';
import { useFormatter } from '../lib/store.js';

export interface DraftBannerProps {
  savedAt: number;
  onRestore: () => void;
  onDiscard: () => void;
}

/** "You have an unsaved order from 14:02" — restore it or throw it away (spec 2.10.2, 3.3). */
export function DraftBanner({ savedAt, onRestore, onDiscard }: DraftBannerProps) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  return (
    <div className="mz-banner" role="status">
      <span style={{ flex: 1 }}>{t('common:draft_found', { time: formatter.timestamp(new Date(savedAt)) })}</span>
      <Button variant="ghost" onClick={onRestore}>
        {t('common:draft_restore')}
      </Button>
      <Button variant="ghost" onClick={onDiscard}>
        {t('common:discard')}
      </Button>
    </div>
  );
}
