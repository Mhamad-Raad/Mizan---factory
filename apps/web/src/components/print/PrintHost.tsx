import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useQueries, useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api.js';
import { BUSINESS_QUERY_KEY, BusinessContext, NO_BUSINESS } from '../../lib/business.js';
import type { Business } from '../../lib/business.js';
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
 * ever sees — a page each — and prints them from a hidden frame of their own once everything,
 * fonts included, is in place: the browser's print dialog opens over the page the reader is on,
 * which stays exactly as it was underneath, with no new tab or window (D-086 addendum). The
 * documents flow page after page in that frame, so a long statement breaks across pages like any
 * other text.
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

  // The business every document is headed with (D-108). A failure to read it prints without it
  // rather than not at all.
  const business = useQuery({
    queryKey: BUSINESS_QUERY_KEY,
    queryFn: () => apiRequest<Business>('/settings/business'),
    staleTime: 60_000,
    retry: false,
  });

  const failed = results.find((result) => result.isError);
  const ready =
    results.length > 0 && results.every((result) => result.isSuccess) && !business.isPending;
  const printed = useRef(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ready || printed.current || !host.current) return undefined;
    printed.current = true;
    return printInFrame(host.current, () => finish(job.id));
  }, [ready, finish, job.id]);

  return (
    <>
      {ready
        ? createPortal(
            <div ref={host} className="mz-print-host" aria-hidden="true">
              <BusinessContext.Provider value={business.data ?? NO_BUSINESS}>
                {results.map((result, index) =>
                  result.data ? (
                    <div key={index} className="mz-print-page">
                      <PrintedDocument data={result.data as PrintData} />
                    </div>
                  ) : null,
                )}
              </BusinessContext.Provider>
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

/**
 * Prints a block from a hidden frame — the way the dashboard's receipts print — and calls `done`
 * when the dialog closes, printed, saved or cancelled alike. The frame carries the app's own
 * stylesheets and the page's language, direction, palette and text size, so paper reads as the
 * reader set the app — but always in the light theme: paper is white, and the dark theme's pale
 * text printed on it barely shows. Returns what removes the frame, should the job be replaced first.
 */
function printInFrame(source: HTMLElement, done: () => void): () => void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Out of sight but laid out: a frame of no size, or `display: none`, prints blank in some browsers.
  Object.assign(frame.style, {
    position: 'fixed',
    insetBlockStart: '-10000px',
    insetInlineStart: '-10000px',
    inlineSize: '210mm',
    blockSize: '297mm',
    border: '0',
  });
  document.body.appendChild(frame);

  let finished = false;
  const remove = () => {
    if (finished) return;
    finished = true;
    frame.remove();
  };
  const frameWindow = frame.contentWindow;
  const sheet = frame.contentDocument;
  if (!frameWindow || !sheet) {
    remove();
    done();
    return remove;
  }

  for (const { name, value } of Array.from(document.documentElement.attributes)) {
    sheet.documentElement.setAttribute(name, value);
  }
  sheet.documentElement.setAttribute('data-theme', 'light');
  const base = sheet.createElement('base');
  base.href = document.baseURI;
  sheet.head.appendChild(base);
  const loading: Promise<unknown>[] = [];
  for (const style of Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))) {
    const copy = sheet.importNode(style, true);
    if (copy instanceof HTMLLinkElement) {
      loading.push(
        new Promise((resolve) => {
          copy.addEventListener('load', resolve, { once: true });
          copy.addEventListener('error', resolve, { once: true });
        }),
      );
    }
    sheet.head.appendChild(copy);
  }
  sheet.body.className = `${document.body.className} mz-printing`;
  sheet.body.appendChild(sheet.importNode(source, true));

  frameWindow.addEventListener(
    'afterprint',
    () => {
      remove();
      done();
    },
    { once: true },
  );
  // A stylesheet that never answers must not hold the print for ever.
  const styled = Promise.race([Promise.all(loading), new Promise((resolve) => setTimeout(resolve, 3000))]);
  void styled
    .then(() => {
      // Laid out first, so the fonts its text needs are asked for before they are waited on.
      void sheet.body.offsetHeight;
      // The logo too (D-108): a page printed before its picture is decoded prints without it.
      const pictures = Array.from(sheet.images).map((image) => image.decode().catch(() => undefined));
      return Promise.all([sheet.fonts.ready, ...pictures]);
    })
    .then(() => {
      if (finished) return;
      // A layout forced in the frame lays the documents out before the dialog takes its
      // snapshot — not animation frames, which an off-screen frame (or a tab in the background)
      // is never given.
      void sheet.body.offsetHeight;
      frameWindow.focus();
      frameWindow.print();
    });
  return remove;
}
