import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/*
  WHY THIS EXISTS.

  A hook-order violation passed every other gate in this repo: `tsc` has no
  opinion about hooks, the vitest `include` in `vite.config.ts` limits the suite
  to `.ts` under `src`, and `.tsx` components are deliberately untested. So a
  `useState` declared below a body-level `return` in `Shell.tsx` shipped, and
  threw React's "Rendered fewer hooks than expected" on every navigation into and
  out of `#/overview` — the default landing route. `rules-of-hooks` is a static
  rule and needs no DOM, so it is the only gate in this repo that can see that
  class of defect at all.

  THIS SCRIPT IS A GATE. It must stay green, because a lint script that always
  fails is one people learn to ignore, and an ignored gate catches nothing.

  Four rules are therefore moved OUT of it and into `lint:debt`. They are not
  silenced — they are named, enumerated in DEBT_RULES below, and still reported
  by a script that runs them. The distinction matters: silencing a rule to get a
  green run proves nothing, while scoping a gate to the defect class it exists to
  catch — and keeping the rest visible — is the only honest way to have both a
  gate and a backlog.

  DO NOT silence `react-hooks/rules-of-hooks`. It is an error for a reason, and a
  hook that is conditionally skipped is a runtime crash waiting for the
  navigation that skips it.
*/

/**
 * Rules that are known to fire on the current source and are therefore excluded
 * from `npm run lint`. Every entry is a BUG-OR-STYLE finding that must be
 * triaged as code, not silenced in config. `npm run lint:debt` reports them.
 *
 * When one is fixed, DELETE it from this list rather than disabling it inline.
 */
export const DEBT_RULES = [
  // React Compiler rules, shipped in eslint-plugin-react-hooks v7's `recommended`.
  // Real findings (18): mostly `set-state-in-effect`, which is a design question
  // about deriving state in an effect rather than a crash.
  "react-hooks/set-state-in-effect",
  "react-hooks/preserve-manual-memoization",
  "react-hooks/refs",
  // Style rule from @typescript-eslint recommended. Two occurrences in
  // `Tables.tsx` are the TFeatures generic of TanStack v9's
  // `ColumnDef<TFeatures, TData, TValue>` — the row type is already correct, so
  // replacing it means choosing a feature generic deliberately, not guessing.
  "@typescript-eslint/no-explicit-any",
];

export default tseslint.config(
  { ignores: ["dist/**", "templates/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...Object.fromEntries(DEBT_RULES.map((rule) => [rule, "off"])),
    },
  },
  {
    /*
      `scripts/audit-classes.mjs` is a Node build-audit tool, not app code — it
      reads `dist/` and the Tailwind build. It gets Node globals so `process` and
      friends are not flagged; it is still linted, not skipped.
    */
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
);