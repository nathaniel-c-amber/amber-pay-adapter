import base, { DEBT_RULES } from "./eslint.config.js";
import reactHooks from "eslint-plugin-react-hooks";

/*
  THE BACKLOG. RUN THIS, DO NOT GATE ON IT.

  `npm run lint` is the gate and must stay green. This script LAYERS the rules
  `eslint.config.js` holds back on top of it, so the known-bad surface stays
  visible instead of being configured into invisibility.

  It layers rather than replaces: ESLint replaces its config when given
  `--config`, so a standalone file here would carry no TypeScript parser and
  `.tsx` would not parse at all. Reusing `base` is what keeps it runnable.

  It currently reports 22 findings (18 React Compiler rules + 2 `no-explicit-any`
  + 4 `exhaustive-deps` warnings). That number is expected to be non-zero. The
  goal is for it to fall to zero as things are fixed — one entry at a time, each
  fixed as code — and for `DEBT_RULES` to shrink as we go.

  `DEBT_RULES` is imported from `eslint.config.js` so the two files cannot drift
  apart. A rule turned on here but forgotten there would be invisible in the
  gate, which is the exact failure this arrangement exists to prevent.

  If you make this script pass by weakening a rule, deleting an assertion, or
  re-silencing something in `eslint.config.js`, you have destroyed the only
  record of the debt and the gate has quietly become decorative.
*/

export default [
  ...base,
  {
    name: "amber/debt-rules",
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...Object.fromEntries(DEBT_RULES.map((rule) => [rule, "error"])),
    },
  },
];