import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, MizanMark } from '@mizan/ui';
import { AppearanceMenus } from './Appearance.js';

interface DoorwayProps {
  /** The card's heading; the application's name when omitted. */
  title?: ReactNode;
  /** One quiet line under the heading. */
  subtitle?: ReactNode;
  children: ReactNode;
}

/**
 * The screens before the shell — sign in, the lock screen, the forced password change.
 *
 * One card of a form's width, centred on a quiet page, with the mark and the name at its head
 * so a shared tablet says which application this is before a word is read (3.2.5, FR-1311).
 * Language, theme and text size sit at the reading end of the top edge, the same menus the app
 * bar carries, because the person who needs Arabic needs it *before* signing in.
 */
export function Doorway({ title, subtitle, children }: DoorwayProps) {
  const { t } = useTranslation();

  return (
    <div className="mz-app mz-doorway">
      <div className="mz-doorway__tools">
        <AppearanceMenus />
      </div>
      <main className="mz-doorway__main">
        <Card className="mz-doorway__card">
          <header className="mz-doorway__head">
            <span className="mz-doorway__mark">
              <MizanMark size={28} title={t('common:app_name')} />
            </span>
            <h1 className="mz-doorway__title">{title ?? t('common:app_name')}</h1>
            {subtitle ? <p className="mz-doorway__subtitle">{subtitle}</p> : null}
          </header>
          {children}
        </Card>
      </main>
    </div>
  );
}
