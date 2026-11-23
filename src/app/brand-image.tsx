// The mark as plain elements for next/og (no CSS classes there): used by apple-icon and the
// Open Graph image.
export function MarkSvg({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <rect width="32" height="32" rx="8" fill="#0d6a5b" />
      <path d="M7.5 15.5 16 8.5l8.5 7" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 14v9.5h12V14" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      <path d="m13 18.8 2.2 2.2 3.8-4.2" fill="none" stroke="#9ff0dc" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
