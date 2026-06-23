export function DateGroup({ label, children }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        {label}
      </h2>
      {children}
    </section>
  )
}
