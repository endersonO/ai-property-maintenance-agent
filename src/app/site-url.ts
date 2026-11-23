// The public origin, for absolute URLs in metadata (the Open Graph image must be fetchable by
// whoever renders a link preview). SITE_URL wins; on Vercel its production URL; localhost only
// in development.
export function siteUrl(env: Record<string, string | undefined> = process.env): URL {
  if (env.SITE_URL) return new URL(env.SITE_URL);
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return new URL(`https://${env.VERCEL_PROJECT_PRODUCTION_URL}`);
  return new URL(`http://localhost:${env.PORT ?? 3000}`);
}
