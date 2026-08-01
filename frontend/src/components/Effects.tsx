import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Feedback effects: toasts for things that arrive, and a 3D "lift" confirmation for things
 * you just did.
 *
 * The lift is the important one. It starts at the exact screen position of the control you
 * pressed, rotated back and small, then rises toward the viewer and settles — so the
 * confirmation visibly comes *out of* the invoice you acted on rather than appearing from
 * nowhere. That connection is the whole point; a centred modal would say the same words and
 * mean less.
 *
 * Everything here honours prefers-reduced-motion: the same messages still appear, they just
 * stop moving.
 */

type Tone = 'clear' | 'inflight' | 'review' | 'posted' | 'blocked';

interface ToastSpec {
  title: string;
  detail?: string;
  tone?: Tone;
}

interface LiftSpec extends ToastSpec {
  /**
   * Where the confirmation should appear to come out of. Pass a `DOMRect` captured with
   * `rectOf()` at the moment of the click, not the element itself: by the time the request
   * resolves the button has usually been unmounted by the list refreshing, and measuring a
   * detached node yields an all-zero rect — the card would fly in from the top-left corner.
   */
  origin?: DOMRect | HTMLElement | null;
  /** Big line under the title — an ERP document number, an amount. */
  stamp?: string;
}

/** Capture where a control is on screen, for `lift({ origin })`. */
export function rectOf(el: HTMLElement | null | undefined): DOMRect | undefined {
  return el ? el.getBoundingClientRect() : undefined;
}

interface EffectsApi {
  toast: (spec: ToastSpec) => void;
  lift: (spec: LiftSpec) => void;
}

const EffectsContext = createContext<EffectsApi | null>(null);

export function useEffectsApi(): EffectsApi {
  const ctx = useContext(EffectsContext);
  if (!ctx) throw new Error('useEffectsApi must be used inside <EffectsProvider>');
  return ctx;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let nextId = 1;

export function EffectsProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<(ToastSpec & { id: number })[]>([]);
  const [lifts, setLifts] = useState<(LiftSpec & { id: number })[]>([]);
  const liftRefs = useRef(new Map<number, HTMLDivElement>());

  const toast = useCallback((spec: ToastSpec) => {
    const id = nextId++;
    setToasts((t) => [...t, { ...spec, id }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  const lift = useCallback((spec: LiftSpec) => {
    const id = nextId++;
    setLifts((l) => [...l, { ...spec, id }]);

    // Animate on the next frame, once the node is mounted and measurable.
    requestAnimationFrame(() => {
      const node = liftRefs.current.get(id);
      const remove = () => {
        setLifts((l) => l.filter((x) => x.id !== id));
        liftRefs.current.delete(id);
      };

      if (!node || prefersReducedMotion() || !node.animate) {
        window.setTimeout(remove, 2200);
        return;
      }

      // Where the card should start: the centre of whatever was pressed, expressed as an
      // offset from where the card already sits (centred in the viewport).
      const card = node.getBoundingClientRect();
      const from =
        spec.origin instanceof DOMRect ? spec.origin : rectOf(spec.origin as HTMLElement | null);
      const dx = from ? from.left + from.width / 2 - (card.left + card.width / 2) : 0;
      const dy = from ? from.top + from.height / 2 - (card.top + card.height / 2) : 140;

      // Easing is per-keyframe, and the animation-level easing is linear, so each leg is
      // timed on its own. A single aggressive ease-out across the whole thing collapses the
      // rise into the first ~10% — the card simply appears, which loses the one thing this
      // effect is for.
      const animation = node.animate(
        [
          {
            transform: `translate3d(${dx}px, ${dy}px, -420px) rotateX(62deg) scale(0.35)`,
            opacity: 0,
            filter: 'blur(6px)',
            easing: 'cubic-bezier(0.24, 0.6, 0.32, 1)', // the rise: decelerating, but travelled
          },
          {
            transform: `translate3d(${dx * 0.16}px, ${dy * 0.16 - 12}px, 46px) rotateX(9deg) scale(1.05)`,
            opacity: 1,
            filter: 'blur(0px)',
            offset: 0.42,
            easing: 'cubic-bezier(0.34, 0, 0.2, 1)', // overshoot settling back
          },
          {
            transform: 'translate3d(0, 0, 0) rotateX(0deg) scale(1)',
            opacity: 1,
            filter: 'blur(0px)',
            offset: 0.6,
            easing: 'linear', // hold, so it can actually be read
          },
          {
            transform: 'translate3d(0, 0, 0) rotateX(0deg) scale(1)',
            opacity: 1,
            offset: 0.84,
            easing: 'cubic-bezier(0.5, 0, 0.85, 0.4)', // accelerate away
          },
          {
            transform: 'translate3d(0, -52px, 110px) rotateX(-8deg) scale(1.03)',
            opacity: 0,
            filter: 'blur(3px)',
          },
        ],
        { duration: 2600, easing: 'linear', fill: 'forwards' },
      );
      animation.onfinish = remove;
      animation.oncancel = remove;
    });
  }, []);

  return (
    <EffectsContext.Provider value={{ toast, lift }}>
      {children}

      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <button
            key={t.id}
            className={`toast tone-${t.tone ?? 'inflight'}`}
            onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
          >
            <span className="beacon" />
            <span className="body">
              <span className="t">{t.title}</span>
              {t.detail && <span className="d">{t.detail}</span>}
            </span>
          </button>
        ))}
      </div>

      {/* Separate layer: perspective has to live on an ancestor for translateZ to read as depth. */}
      <div className="lift-stage" aria-live="assertive">
        {lifts.map((l) => (
          <div
            key={l.id}
            className={`lift tone-${l.tone ?? 'clear'}`}
            ref={(node) => {
              if (node) liftRefs.current.set(l.id, node);
            }}
          >
            <span className="lbl">{l.detail ?? 'Confirmed'}</span>
            <span className="headline">{l.title}</span>
            {l.stamp && <span className="stamp">{l.stamp}</span>}
          </div>
        ))}
      </div>
    </EffectsContext.Provider>
  );
}
