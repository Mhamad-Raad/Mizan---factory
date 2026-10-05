import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BottomSheet, Button } from '@mizan/ui';
import { answerWarning, useIdleSecondsLeft } from '../lib/idleSignOut.js';
import { useFormatter } from '../lib/store.js';

/**
 * The last minute before an idle session is ended (D-078): says so, counts down, and takes any
 * answer — the button, a key, a press anywhere — as the user being there. Mounted once, above
 * every screen, the lock screen included.
 */
export function IdleWarning() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const secondsLeft = useIdleSecondsLeft();
  // The figure stays while the sheet leaves, instead of dropping to nothing.
  const [shown, setShown] = useState(secondsLeft ?? 0);
  if (secondsLeft !== null && secondsLeft !== shown) setShown(secondsLeft);

  return (
    <BottomSheet
      title={t('auth:idle_title')}
      open={secondsLeft !== null}
      onClose={answerWarning}
      closeLabel={t('common:close')}
    >
      <div className="mz-stack">
        <p role="status">{t('auth:idle_body', { seconds: formatter.number(shown) })}</p>
        <Button block onClick={answerWarning}>
          {t('auth:idle_stay')}
        </Button>
      </div>
    </BottomSheet>
  );
}
