import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { InboxItem } from '../api/types';
import { useEffectsApi } from '../components/Effects';

const POLL_MS = 15_000;

/**
 * Fired by any screen that has just changed the acting user's queue, so the sidebar count
 * updates on the same tick as the screen rather than lagging until the next poll. A window
 * event rather than lifted state: the watcher lives in the shell and the screens that change
 * the queue are several routes down, and there is nothing else to share.
 */
export const INBOX_CHANGED = 'flowap:inbox-changed';

export function notifyInboxChanged() {
  window.dispatchEvent(new Event(INBOX_CHANGED));
}

/**
 * Watches one approver's queue and announces arrivals.
 *
 * Approval in this system is **pull**: a step is created and the approver has to go looking
 * for it (CLAUDE.md lists notification as the biggest gap after auth). This closes the
 * in-app half of that — while the workspace is open, an invoice reaching your queue says so
 * wherever you happen to be standing, instead of waiting silently on the inbox screen.
 *
 * It compares *step ids*, not counts. A poll where one step is approved and another arrives
 * leaves the count unchanged, and a count check would miss the new one entirely.
 *
 * It is still only a poll against an open tab. Email, push and digests remain unbuilt.
 */
export function useInboxWatch(approverId: string): { waiting: number } {
  const { toast } = useEffectsApi();
  const [waiting, setWaiting] = useState(0);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!approverId) return;

    // A different person is acting: forget the previous queue rather than reporting
    // their whole inbox as newly arrived.
    seen.current = null;
    let stopped = false;

    async function poll() {
      let items: InboxItem[];
      try {
        items = await api.inbox(approverId);
      } catch {
        return; // A failed poll is not worth a toast; the next one will catch up.
      }
      if (stopped) return;

      setWaiting(items.length);
      const ids = new Set(items.map((i) => i.step.id));

      if (seen.current === null) {
        // First look. Announce what is already waiting once, then track deltas.
        if (items.length > 0) announce(items);
      } else {
        const fresh = items.filter((i) => !seen.current!.has(i.step.id));
        if (fresh.length > 0) announce(fresh);
      }
      seen.current = ids;
    }

    function announce(items: InboxItem[]) {
      const [first] = items;
      toast({
        title:
          items.length === 1
            ? 'Invoice ready to be approved'
            : `${items.length} invoices ready to be approved`,
        detail:
          items.length === 1
            ? `${first.invoiceNumber ?? 'Untitled'} · ${first.vendorName ?? 'unresolved vendor'}`
            : 'Open My approvals to decide them.',
        tone: 'inflight',
      });
    }

    const onChanged = () => void poll();
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    window.addEventListener(INBOX_CHANGED, onChanged);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener(INBOX_CHANGED, onChanged);
    };
  }, [approverId, toast]);

  return { waiting };
}
