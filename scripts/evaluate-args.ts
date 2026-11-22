// Argument parsing for `pnpm evaluate`, kept apart from the script so it can be tested.

const UNITS: Record<string, number> = { h: 3_600_000, d: 86_400_000 };

// Default 7d. A bare `--since` is an error, never "everything": an incomplete command must
// not widen the window.
export function sinceArg(args: string[]): string {
  if (!args.includes("--since")) return "7d";
  const value = args[args.indexOf("--since") + 1];
  if (!value || value.startsWith("--")) throw new Error("--since needs a value: 24h, 7d or all");
  return value;
}

export function parseSince(value: string): Date | null {
  if (value === "all") return null;
  const match = /^(\d+)([hd])$/.exec(value);
  if (!match) throw new Error(`--since must look like 24h, 7d or all (got "${value}")`);
  return new Date(Date.now() - Number(match[1]) * UNITS[match[2]]);
}
