import { motion } from 'motion/react'

/**
 * Placeholder shell. This exists to prove the Vite + Tailwind + Motion wiring works
 * end to end; replace it with the real screens (invoice list, invoice detail with
 * confidence-flagged fields, exception queue) as they get built.
 */
function App() {
  return (
    <main className="min-h-full bg-sunken text-ink">
      <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6 px-6 py-16">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="rounded-xl border border-line bg-surface p-8 shadow-sm"
        >
          <p className="text-sm font-medium tracking-wide text-accent uppercase">
            Frontend scaffold
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Universal Invoice Management Platform
          </h1>
          <p className="mt-3 text-muted">
            React 19 + TypeScript on Vite, styled with Tailwind v4 and animated with
            Motion. No screens are built yet — start in{' '}
            <code className="rounded bg-sunken px-1.5 py-0.5 text-sm">src/App.tsx</code>.
          </p>
        </motion.div>

        <motion.ul
          initial="hidden"
          animate="shown"
          variants={{
            shown: { transition: { staggerChildren: 0.08, delayChildren: 0.2 } },
          }}
          className="grid gap-3"
        >
          {[
            'Invoice list',
            'Invoice detail with confidence-flagged fields',
            'Exception queue',
          ].map((screen) => (
            <motion.li
              key={screen}
              variants={{
                hidden: { opacity: 0, y: 8 },
                shown: { opacity: 1, y: 0 },
              }}
              className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted"
            >
              {screen}
            </motion.li>
          ))}
        </motion.ul>
      </div>
    </main>
  )
}

export default App
