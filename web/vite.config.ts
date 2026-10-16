import { fileURLToPath, URL } from "node:url";
/*
  `defineConfig` comes from `vitest/config`, not `vite`, so the `test` block
  below is type-checked. It is a superset of Vite's, so the build is unchanged —
  and keeping ONE config file means the `@` alias above cannot drift between the
  bundler and the test runner, which is the usual way a second config rots.
*/
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // "@/*" -> "src/*" — kept in sync with the `paths` entry in tsconfig.json.
    // `import.meta.url` is used rather than `__dirname` because this config is
    // loaded as ESM ("type": "module").
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    /*
      NODE, and `.ts` only — deliberately, because that is the SCOPE, not a
      limitation. These are unit tests over pure logic (the authorization gate,
      the flow aggregate, the validation rules). React components are NOT tested
      here: `web/` has no jsdom or Testing Library, and the one component defect
      that actually shipped (the permission editor re-seeding a cleared row from
      its baseline) is a STATE bug, invisible to every gate in this repo. If
      component tests are ever wanted, they need jsdom + @testing-library added
      and this block revisited — do not widen `include` to `.tsx` first.
    */
    environment: "node",
    include: ["src/**/*.test.ts"],
    /*
      TZ pinned so the date tests are deterministic. `datetime.ts` formats in the
      OPERATOR'S zone (correct for a console — people read their own clock), which
      meant a fixed UTC instant rendered as "9:58 AM" on one machine and
      "2:58 PM" on another. Pinning here does not change production behaviour; it
      only stops the suite from measuring the machine it runs on. Set in
      `process.env` at config time, which is early enough for Intl.
    */
    env: { TZ: "UTC" },
  },
  server: {
    port: 5173,
    open: false,
    proxy: {
      "/api": {
        target: "http://localhost:3300",
        changeOrigin: true,
      },
    },
  },
});