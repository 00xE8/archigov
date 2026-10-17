import React from "react";
import { blue40, blue50, blue60, blue70, gray10, gray100 } from "@carbon/colors";

/** The Archigov mark: a plumb line — a stem and a bob hanging at rest (geometry and variants: the private repo's
 *  site/brand/mark.py). Decorative beside the wordmark, so it is hidden from assistive technology. */
export function BrandMark({ onDark = false, className = "ag-mark" }: { onDark?: boolean; className?: string }) {
  const id = React.useId().replace(/:/g, "");
  const [from, to] = onDark ? [blue40, blue60] : [blue50, blue70];
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs><linearGradient id={`bob${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={from} /><stop offset="1" stopColor={to} /></linearGradient></defs>
      <rect x="16" y="6" width="12" height="52" rx="6" fill={onDark ? gray10 : gray100} />
      <circle cx="37" cy="37" r="15" fill={`url(#bob${id})`} />
    </svg>
  );
}
