import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EffectsProvider } from '../components/Effects';

/**
 * Renders a screen inside the same providers `main.tsx` gives it.
 *
 * `EffectsProvider` is included rather than stubbed: `useEffectsApi()` throws outside it, so
 * a test that omitted it would fail for the wrong reason, and the toast/lift copy is part of
 * what an operator actually sees after approving or posting.
 */
export function renderScreen(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <EffectsProvider>{ui}</EffectsProvider>
    </MemoryRouter>,
  );
}

export const signIn = (token = 'test-token') => localStorage.setItem('flowap.accessToken', token);
