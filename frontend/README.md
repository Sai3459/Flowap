# Frontend

React 19 + TypeScript on Vite. Styling is Tailwind v4, animation is Motion
(the library formerly published as `framer-motion`).

## Run

```bash
cd frontend
npm install
cp .env.example .env
npm run dev             # http://localhost:5173
```

`.env` needs two values. `VITE_API_BASE_URL` defaults to the backend on `:3000`.
`VITE_TENANT_ID` has no default — the API returns nothing without it:

```bash
psql "$DATABASE_URL" -tAc "SELECT id FROM tenants LIMIT 1"
```

That is a prototype stand-in for the `x-tenant-id` header the backend reads. It goes
away with SSO; a real client must never choose its own tenant.

The backend starts with `cors: true` (see `backend/src/main.ts`), so the dev server
talks to it directly over `VITE_API_BASE_URL` — there is no Vite proxy to keep in sync.

Other scripts: `npm run build` (type-checks with `tsc -b`, then bundles),
`npm run preview`, `npm run lint` (oxlint).

## What's here

```
src/lib/        api client, shared types, formatters
src/components/ table, status badge, confidence cell
src/routes/     one page per screen
```

Built: the **invoice list** (`GET /invoices`) with status filters, sortable columns,
and per-field confidence. Still to come: invoice detail with inline correction, the
exception queue (`GET /invoices/exceptions` already exists), and the mobile approval view.

Radix supplies the accessible primitives and TanStack Table the headless table logic,
so markup and styling stay ours — the same split shadcn/ui uses.

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
