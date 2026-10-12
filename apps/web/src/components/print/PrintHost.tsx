import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useQueries } from '@tanstack/react-query';
import { Toast } from '@mizan/ui';
import { usePrintQueue } from '../../lib/print.js';
import type { PrintJob } from '../../lib/print.js';
import { useApp } from '../../lib/store.js';
import { errorMessage } from '../../lib/errors.js';
import { loadDocument, printKey } from './load.js';
import type { PrintData } from './load.js';
import { PrintedDocument } from './PrintedDocuments.js';

/**
 * The one place the system prints from (D-086), mounted once beside the app.
 *
 * A screen hands it documents; it fetches them all, renders them into a block that only paper
 * ever sees — a page each — and opens the browser's print dialog once everything, fonts included,
 * is in place. Printing used to be an off-screen copy on each page, lifted to the top of the
 * sheet with `position: absolute`: one document, and never more than one page of it. Here the app
 * is taken off the paper instead, so documents flow page after page, and a long statement breaks
 * across pages like any other text.
 */
export function PrintHost() {
  const job = usePrintQueue((state) => state.job);
  if (!job) return null;
  // Keyed by the job, so a new request starts from nothing instead of inheriting a half-loaded one.
  return <PrintRun key={job.id} job={job} />;
}

function PrintRun({ job }: { job: PrintJob }) {
  const { t } = useTranslation();
  const finish = usePrintQueue((state) => state.finish);
  const permissions = useApp((state) => state.permissions);
  const isAdmin = useApp((state) => state.user?.role === 'admin');
  const may = (permission: string) => isAdmin || permissions.has(permission);

  const results = useQueries({
    queries: job.documents.map((document) => ({
      queryKey: printKey(document),
      queryFn: () => loadDocument(document, may),
      // Printed as the record stands now, never from a cache filled an hour ago.
      staleTime: 0,
      gcTime: 0,
      retry: false,
    })),
  });

  const failed = results.find((result) => result.isError);
  const ready = results.length > 0 && results.every((result) => result.isSuccess);
  const printed = useRef(false);

  useEffect(() => {
    if (!ready || printed.current) return undefined;
    printed.current = true;
    let cancelled = false;
    const done = () => {
      document.body.classList.remove('mz-printing');
      finish(job.id);
    };
    // The browser says when the dialog has closed — printed, saved or cancelled alike.
    window.addEventListener('afterprint', done, { once: true });
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      document.body.classList.add('mz-printing');
      // Two frames: the documents are laid out before the dialog takes its snapshot.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!cancelled) window.print();
        }),
      );
    });
    return () => {
      cancelled = true;
      window.removeEventListener('afterprint', done);
      document.body.classList.remove('mz-printing');
    };
  }, [ready, finish, job.id]);

  return (
    <>
      {ready
        ? createPortal(
            <div className="mz-print-host" aria-hidden="true">
              {results.map((result, index) =>
                result.data ? (
                  <div key={index} className="mz-print-page">
                    <PrintedDocument data={result.data as PrintData} />
                  </div>
                ) : null,
              )}
            </div>,
            document.body,
          )
        : null}
      {failed ? (
        <Toast
          message={errorMessage(t, failed.error) ?? t('print:failed')}
          actionLabel={t('common:close')}
          onAction={() => finish(job.id)}
        />
      ) : !ready ? (
        <Toast message={t('print:preparing')} />
      ) : null}
    </>
  );
}
