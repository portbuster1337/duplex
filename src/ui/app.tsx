// The root component: single-tab check, onboarding/unlock and the main layout.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Session } from '../app/session';
import { Setup, Unlock } from './onboarding';
import { Main } from './layout';
import { Spinner, Toasts } from './components';

type Phase = { p: 'loading' } | { p: 'otherTab' } | { p: 'setup' } | { p: 'locked' } | { p: 'ready'; session: Session };

let onTabLockLost: () => void = () => {};

/**
 * Only one tab may use the profile: two tabs would both subscribe to the same queues. A tab can take
 * over, and then the tab that had the lock disconnects.
 */
function acquireTabLock(steal = false): Promise<boolean> {
  if (!('locks' in navigator)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let held = false;
    navigator.locks
      .request('duplex-active-tab', steal ? { steal: true } : { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        held = true;
        resolve(true);
        // held while the page is open
        return new Promise<void>(() => {});
      })
      .catch(() => {
        // the request of the tab holding the lock is rejected when another tab takes it
        if (held) onTabLockLost();
        else resolve(false);
      });
  });
}

export function App(): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ p: 'loading' });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const init = async (steal = false) => {
    let ok = await acquireTabLock(steal);
    // after a reload, the previous page may still be releasing the lock
    for (let i = 0; !ok && !steal && i < 3; i++) {
      await new Promise((r) => setTimeout(r, 300));
      ok = await acquireTabLock();
    }
    if (!ok) return setPhase({ p: 'otherTab' });
    setPhase({ p: (await Session.exists()) ? 'locked' : 'setup' });
  };

  useEffect(() => {
    onTabLockLost = () => {
      const ph = phaseRef.current;
      if (ph.p === 'ready') void ph.session.lock();
      setPhase({ p: 'otherTab' });
    };
    init();
  }, []);

  useEffect(() => {
    if (phase.p !== 'ready') return;
    const s = phase.session;
    // the session is closed when leaving the page; if the page is restored from the back/forward
    // cache, it has to be unlocked again
    const onHide = () => {
      void s.lock();
      setPhase({ p: 'locked' });
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [phase]);

  let body: JSX.Element;
  switch (phase.p) {
    case 'loading':
      body = (
        <div class="center">
          <Spinner label="Loading…" />
        </div>
      );
      break;
    case 'otherTab':
      body = (
        <div class="onboarding">
          <div class="card">
            <h1>Duplex is open in another tab</h1>
            <p class="muted">Only one tab can be connected at a time.</p>
            <button class="primary" onClick={() => init(true)}>
              Use it here
            </button>
          </div>
        </div>
      );
      break;
    case 'setup':
      body = <Setup onReady={(session) => setPhase({ p: 'ready', session })} />;
      break;
    case 'locked':
      body = <Unlock onReady={(session) => setPhase({ p: 'ready', session })} onWiped={() => setPhase({ p: 'setup' })} />;
      break;
    case 'ready':
      body = (
        <Main
          session={phase.session}
          onLock={async () => {
            await phase.session.lock();
            setPhase({ p: 'locked' });
          }}
          onWiped={() => setPhase({ p: 'setup' })}
        />
      );
      break;
  }
  return (
    <>
      {body}
      <Toasts />
    </>
  );
}
