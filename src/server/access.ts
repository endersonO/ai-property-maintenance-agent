// Demo gate, not authentication: when DEMO_ACCESS_CODE is set (public deploy), pages and the
// chat API require it, so strangers can't spend the model quota or read traces.
export function accessGranted(code: string | string[] | undefined): boolean {
  const expected = process.env.DEMO_ACCESS_CODE;
  return !expected || code === expected;
}

// Query suffix that keeps the code on internal links.
export const withCode = (code: string | string[] | undefined) =>
  typeof code === "string" && code ? `?code=${encodeURIComponent(code)}` : "";
