import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ErrorState } from '@mizan/ui';
import { ChunkLoadError } from '../lib/chunk.js';

interface Props {
  /** Changes with the route: a new screen gets a fresh try, without a reload. */
  resetKey: string;
  /** Somewhere to go from a screen that will not render — the shell is inside the page. */
  onLeave: () => void;
  children: ReactNode;
}

interface State {
  /** Nothing failed, the screen's file did not arrive, or the screen failed to draw. */
  failed: false | 'chunk' | 'render';
}

interface Words {
  title: string;
  body: string;
}

/**
 * What the employee sees when a screen cannot be loaded at all (NFR-10, FR-1305).
 *
 * Route splitting (I6) means every screen after the first is a file that has to arrive, and
 * three ordinary things stop it arriving: the tablet is in the yard with no signal, the
 * connection dropped mid-fetch, or the server was deployed while this tab stayed open and the
 * old content-hashed file is gone. Without a boundary React unmounts the whole tree on that
 * rejection — a white screen, with the shell and the working screens taken down too — and
 * `React.lazy` caches the rejection, so going back and forward does not recover it.
 *
 * So: an error state that says which of the two it is, and a reload, which is the one action
 * that genuinely fixes a chunk that is no longer on the server. Navigating somewhere else
 * clears it, because that screen's file may well be in the cache already.
 */
class Boundary extends Component<
  Props & { chunk: Words; render: Words; reload: string; leave: string },
  State
> {
  override state: State = { failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: error instanceof ChunkLoadError ? 'chunk' : 'render' };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is where a developer looks; the screen stays in the employee's language.
    console.error('a screen failed to load', error, info.componentStack);
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const words = this.state.failed === 'chunk' ? this.props.chunk : this.props.render;
    // A <div>: the shell's own <main> is already around this, and a page has one main.
    return (
      <div>
        <ErrorState
          title={words.title}
          body={words.body}
          action={
            // Two ways out, because the navigation bar lives inside the screen that failed:
            // reload, which is what fixes a file the server no longer has, and leave, which
            // costs nothing when the next screen is already in the cache.
            <div className="mz-row" style={{ gap: 'var(--space-2)' }}>
              <Button onClick={() => window.location.reload()}>{this.props.reload}</Button>
              <Button variant="secondary" onClick={this.props.onLeave}>
                {this.props.leave}
              </Button>
            </div>
          }
        />
      </div>
    );
  }
}

export function RouteBoundary({ resetKey, onLeave, children }: Props) {
  const { t } = useTranslation();
  // Offline is a different sentence from broken, and the difference is the only thing the
  // employee can act on: wait for signal, or reload. A screen that arrived and then failed to
  // draw is neither, and says so rather than blaming the connection.
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return (
    <Boundary
      resetKey={resetKey}
      onLeave={onLeave}
      chunk={{
        title: offline ? t('common:offline_title') : t('common:error_title'),
        body: offline ? t('common:offline_not_loaded') : t('common:error_body'),
      }}
      render={{ title: t('common:screen_failed_title'), body: t('common:screen_failed_body') }}
      reload={t('common:reload')}
      leave={t('common:back')}
    >
      {children}
    </Boundary>
  );
}
