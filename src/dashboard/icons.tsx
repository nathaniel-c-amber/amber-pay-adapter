import type { SVGProps } from "react";

/* Authored icon set — one consistent stroke family (stroke-width 1.5),
   no unicode glyphs or emoji. All render currentColor. */

const base = (p: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> => ({
  ...p,
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
});

export const IconTick = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3.5 12.5 L8.5 5.5 L12.5 12.5" />
  </svg>
);

export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M8 1.5 L8 5.5 M2.6 13.4 L8 8 L13.4 13.4 M3.4 5.4 L12.6 5.4" />
  </svg>
);

export const IconSync = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12.7 5.4 A3.5 3.5 0 1 1 8.6 2.6 L8 4 L8 13.4" />
  </svg>
);

export const IconBell = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M5.9 8.6 L5.9 12 M10.1 12 L10.1 8.6 L8 3.9 L8 5.4" />
    <path d="M8 5.4 A3.4 3.4 0 0 1 11.4 8.8" />
  </svg>
);

export const IconShield = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M8 3 L3.2 13 L12.8 13 M5.6 8 L5.6 8 M10.4 8 L10.4 8" />
  </svg>
);

export const IconClock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 8 L8 4.4 M8 8 L11 9.6" />
  </svg>
);

/* A network/connector link: two ports joined by a 45°-bent route. */
export const IconLink = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="3.5" cy="12.5" r="1.6" />
    <circle cx="12.5" cy="3.5" r="1.6" />
    <path d="M3.5 12.5 L6.5 9.5 L9.5 6.5 L12.5 3.5" />
  </svg>
);

/* A policy / attribute badge: a hex-plate with a tick. */
export const IconPolicy = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M8 2.5 L13 5 L13 9.5 L8 13.5 L3 9.5 L3 5 Z" />
    <path d="M5.9 8.4 L7.3 9.8 L10.2 6.9" />
  </svg>
);
