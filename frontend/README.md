# Frontend

React 19 + TypeScript on Vite. Styling is Tailwind v4, animation is Motion
(the library formerly published as `framer-motion`).

## Run

```bash
cd frontend
npm install
cp .env.example .env    # VITE_API_BASE_URL, defaults to the backend on :3000
npm run dev             # http://localhost:5173
```

The backend starts with `cors: true` (see `backend/src/main.ts`), so the dev server
talks to it directly over `VITE_API_BASE_URL` — there is no Vite proxy to keep in sync.

Other scripts: `npm run build` (type-checks with `tsc -b`, then bundles),
`npm run preview`, `npm run lint` (oxlint).

## What's here

Only the scaffold. `src/App.tsx` is a placeholder that exists to prove the
Vite + Tailwind + Motion wiring works; replace it with the real screens — invoice
list, invoice detail with confidence-flagged fields, exception queue.

## Three things that will bite you

**Tailwind v4 has no `tailwind.config.js`.** Design tokens live in the `@theme` block
in `src/index.css`, and each token generates utilities — `--color-ink` gives you
`text-ink`, `bg-ink`, `border-ink`.

**Do not put `@theme` inside a media query.** Tailwind flattens `@theme` no matter what
at-rule wraps it, so a nested `@theme` in `@media (prefers-color-scheme: dark)` applies
its values in light mode too. Dark mode therefore overrides the generated custom
properties in a plain `:root` block instead. This was caught by a rendering check, not
by the build — the build passes either way.

**Import Motion from `motion/react`,** not `motion`. The bare entrypoint is the
vanilla-JS API and has no React components.
