# AGENTS.md

Project-specific guidance for AI coding agents.

<!-- STRUCTURE:START -->
`web/src/` is grouped **by type**. Respect the dependency direction
(`pages` → `components`/`services`/`utils` → `types`); never import upward.

| Folder | Holds |
| --- | --- |
| `pages/` | One component per route. `pages/auth/` holds the unauthenticated screens (sign-in, invite, denied). |
| `components/` | Reusable presentational UI: `ui.tsx` (primitives + treatments), `Shell.tsx` (app frame), `Tables.tsx`, `NetworkMap.tsx`, `FlowSpine.tsx`, `ServiceWindow.tsx`, `icons.tsx`, `auth/`. |
| `services/` | Data access and integration: `client.ts` (fetch + token), `auth.service.ts`, `map.service.ts` (API → display shapes), `dashboard.service.ts`. |
| `types/` | Type declarations only: `api.ts` (wire shapes), `domain.ts` (console domain model). |
| `utils/` | Pure helpers with no React: `flow.ts`, `vocabulary.ts`, `permissions.ts`, `fixtures.ts`. |
| `styles/` | `tailwind.css` — the ONLY stylesheet. |
| `router.ts` | Hash router (app wiring). |

RULES:
- Cross-directory imports use the `@/` alias (→ `src/`). Same-directory imports stay `./x`.
  The alias is wired in `tsconfig.json` (`paths`), `vite.config.ts` (`resolve.alias`) and must stay in sync.
- Components never fetch. Pages compose components and call `services/`.
- A component that needs a value derives it in `utils/`, not inline in two places.
<!-- STRUCTURE:END -->

<!-- STYLING:START -->
Styling is **Tailwind CSS v4** — configured entirely in CSS, with no `tailwind.config.js`
and no PostCSS config. Read this before writing any UI.

ENTRY POINT: `src/styles/tailwind.css` (`@import "tailwindcss"`, an `@theme` token block, a
`@layer base` element layer, and one project `@utility`). It is imported once, in `src/main.tsx`.
It is the ONLY stylesheet in `web/`.

TOKENS — every value comes from `@theme`. There are no raw hex/px values in components.
- Colour: `--color-ink-1..4`, `--color-midnight[-2|-3|-raised]`, `--color-rule-enamel[-soft]`,
  `--color-line-{scarlet,cobalt,amber,green}`, `--color-primary*`, `--color-on-primary`,
  `--color-secondary*`, `--color-state-{arriving,delayed,suspended}`, `--color-state-tint-*`,
  `--color-text-{suspended,delayed}`, `--color-focus`, `--color-sel-bg`.
  The default palette is cleared, so `bg-white`/`text-slate-500` do not exist — deliberately.
- Type: `text-micro` (11px) `-xs` (12) `-sm` (13) `-md` (14) `-lg` (15) `-base` (16)
  `-xl` (17) `-2xl` (20) `-3xl` (24). The `--text-*` namespace is cleared, so a `text-*`
  utility sets font-size ONLY; choose line-height separately with `leading-tight|snug|base|prose`.
- Weight: `font-regular|medium|strong|semibold` (400/500/550/600). `font-bold` does not exist —
  browsers defaulting `<b>`/`<th>` to 700 was a real defect, and the base layer re-points them.
- Space: Tailwind's native 4px scale (`p-4` = 16px). The old `--space-N` ramp equalled this scale
  doubled, so old `space-6` is now `4`.
- Radius `rounded-panel` (4px — cards, controls, inputs, panels) / `rounded-chip` (6px — chips,
  status pills, badges); shadow `shadow-soft` / `shadow-panel`;
  `mono` (project utility: mono face + tabular, lining figures — replaces the old `.mono` class).

BREAKPOINTS are `max-*`-only, and named by tier: `max-xs`480 `max-sm`640 `max-md`720 `max-lg`860
`max-xl`900 `max-2xl`1024 `max-3xl`1080 `max-4xl`1100 `max-5xl`1200. Values carry a +0.02px bump so
`max-2xl` matches at exactly 1024px, matching the `@media (max-width: N)` blocks it replaced.
Larger breakpoints are emitted FIRST, so a narrower tier overrides a wider one — write the
base (wide) style unvariant and layer narrower tiers on top.

RULES:
- No raw hex/px/rem in `className`. Use a token utility, or `var(--color-*)` inside an arbitrary
  value for the handful of translucent literals that have no token.
- Never white on `bg-primary`. The ink for the amber is `text-on-primary` (#1a1206); white measures
  3.31:1 and fails WCAG AA.
- `ink-4` is separators/disabled only — never information.
- Never `transition-all`; name the properties. It animates non-animatable properties, costs paint
  work, and leaves controls permanently "in flight" (it broke Playwright actionability once).
- **A Tailwind class that does not exist emits no CSS and raises no error.** A green build proves
  nothing. Run `npm run audit:classes` after changing markup; it fails on any class that resolves to
  no rule. Verified styling changes in a browser, by measurement, not by reading the diff.
- **Same-property utilities in one `className` resolve by STYLESHEET order, not class order.**
  `border-primary` is emitted before `border-rule-enamel`, so layering them is a coin flip. Build
  variant treatments as whole mutually-exclusive strings (see `BTN`/`BTN_PRIMARY` and `NAV_ITEM_ON`/
  `NAV_ITEM_OFF` in `components/ui.tsx` and `components/Shell.tsx`) rather than base-plus-override.
- Bars/states must carry shape or a word as well as colour — status is never colour-only.
- Runtime-composed class names must go through a typed lookup `Record`, not `${interpolation}`.
<!-- STYLING:END -->

## Tests — Vitest, pure logic only

`npm run test` (watch: `npm run test:watch`). Configured in the `test` block of `vite.config.ts`,
which imports `defineConfig` from `vitest/config` rather than `vite` so the block is type-checked.
ONE config file means the `@` → `src` alias cannot drift between the bundler and the runner.

**SCOPE IS PURE LOGIC, `.ts` ONLY — `include: ["src/**/*.test.ts"]`.** That is a decision, not a
limit. Covered: `utils/permissions.ts` (the client authorization gate), `utils/flow.ts`,
`utils/settingsRules.ts`, `utils/datetime.ts`, `utils/passwordRules.ts`.

**Components are deliberately NOT tested.** There is no jsdom or Testing Library here, and the one
component defect that actually shipped — the permission editor re-seeding a cleared row from its
baseline, making it impossible to remove a scope from a user — was pure React state that every
other gate missed: build green, `audit:classes` green, and the 531-test server suite green. It was
found by clicking the box in a browser. **Adding `.tsx` to `include` without jsdom would produce
tests that cannot mount anything**; if component tests are wanted later, add jsdom +
`@testing-library/react` first and revisit the block.

Two things to know before writing a test here:
- **`TZ` is pinned to UTC** in the `test.env` block. `datetime.ts` formats in the OPERATOR's zone
  (correct for a console), so without pinning, a fixed instant rendered as "9:58 AM" on one machine
  and "2:58 PM" on another and the suite measured the machine rather than the format.
- **Tests are typechecked and excluded from the bundle.** `tsconfig.json` has `include: ["src"]` and
  `noEmit: true`, so `npm run typecheck` covers test files; Vite only walks the entry graph, so
  nothing test-shaped reaches `dist` (verified: bundle hash unchanged, 0 test files in `dist`).

**Where it runs: manually, before you call a change done.** There is no CI in this repo, so a test
that nobody runs is decoration that manufactures confidence. The pre-flight for a frontend change is
`npm run test` → `npm run typecheck` → `npm run build` → `npm run audit:classes`.

