export function AccessForm({ locked = false }: { locked?: boolean }) {
  return (
    <form method="get" className="mx-auto mt-16 max-w-sm space-y-3 rounded-lg border border-border bg-surface p-6 shadow-panel">
      <h1 className="text-title font-semibold">Access code required</h1>
      <p className="text-body text-muted">This public demo is protected to limit API usage.</p>
      {locked ? (
        <p role="alert" className="text-body text-error">
          Too many attempts. Please try again in 15 minutes.
        </p>
      ) : (
        <>
          <label htmlFor="code" className="block text-label text-muted">
            Access code
          </label>
          <input
            id="code"
            name="code"
            required
            autoComplete="off"
            className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-body"
          />
          <button
            type="submit"
            className="rounded-md bg-accent px-4 py-2 text-body font-medium text-accent-text hover:bg-accent-hover"
          >
            Continue
          </button>
        </>
      )}
    </form>
  );
}
