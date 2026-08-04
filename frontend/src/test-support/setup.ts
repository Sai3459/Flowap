import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Shared setup for every frontend test.
 *
 * Two things are deliberate here.
 *
 * **`fetch` is stubbed to throw by default.** A test that reaches the network is not testing
 * the thing it claims to; it is testing whatever happens to be running on port 3000. Failing
 * loudly means an un-stubbed call shows up as a failure in the test that caused it rather
 * than as a mysterious timeout somewhere else.
 *
 * **`localStorage` is cleared between tests.** The session token lives there, so a leftover
 * token from one test would sign the next one in and hide a sign-in regression.
 */
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected network call to ${String(input)} — stub it with fakeApi().`);
    }),
  );
  // jsdom's `getBoundingClientRect` returns a plain object rather than a `DOMRect`, which a
  // real browser does not. Left alone, the lift effect's origin handling would be tested
  // against a fiction. Everything is zero here because jsdom does no layout — the effect only
  // needs a well-typed rect, not a truthful one.
  Element.prototype.getBoundingClientRect = function boundingRect() {
    return new DOMRect(0, 0, 0, 0);
  };

  // jsdom does not implement the Web Animations API the lift effect uses. Returning a stub
  // rather than leaving it undefined keeps the effect's own code on the tested path.
  if (!Element.prototype.animate) {
    Element.prototype.animate = vi.fn(() => ({
      finished: Promise.resolve(),
      cancel: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof Element.prototype.animate;
  }
  // Nor matchMedia, which Effects.tsx reads to honour prefers-reduced-motion.
  if (!window.matchMedia) {
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
