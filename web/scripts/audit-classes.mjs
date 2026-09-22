/*
 * Resolve every class token used in the React source against the compiled
 * Tailwind output.
 *
 * WHY THIS EXISTS: a Tailwind class that does not exist produces no CSS and
 * raises no build error. A typo, a renamed token, or a utility that was never
 * generated renders as nothing and a green build proves nothing. This is the
 * only check that catches that class of failure.
 *
 * Usage: npm run audit:classes   (build first — it reads dist/assets/*.css)
 * Exits non-zero if any class resolves to no rule.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------------------------------------------------------------- gather */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Classes the source composes at runtime (`${health}`, `is-${tone}`) cannot be
 * recovered from a static scan, so the domain vocabularies that produce them are
 * declared here. Prefer a typed lookup `Record` in the component over string
 * interpolation — then this list stays short.
 */
const DYNAMIC = new Set([
  /* A project @utility, not a theme-driven utility. */
  "mono",
  /* health / severity / tone vocabularies */
  "healthy", "degraded", "failed", "stopped", "unknown",
  "critical", "warning", "info", "attention",
  "good", "bad", "warn", "neutral",
  /* component state modifiers */
  "is-met", "is-over", "is-worse", "is-improved", "is-muted", "is-bad",
  "is-warn", "is-down", "is-stage", "is-blind",
  "on", "active", "live", "read", "write", "admin", "pending", "primary",
  "compact", "open", "empty", "loading", "error", "drawer-open", "demo",
]);

/**
 * Legacy styling hooks that have NO rule in any stylesheet — verified by
 * grepping every sheet for the selector before those sheets were removed. They
 * already render as nothing, so they are reported for visibility but are not
 * failures. Deleting them is a separate, purely cosmetic cleanup.
 */
const KNOWN_NOOP = new Set([
  "amb-crumb", "auth-foot", "cadence-value", "config-cadence", "config-webhook",
  "cd-events", "cd-findings", "cd-map", "cd-state",
  "cn-events", "cn-list", "cn-map", "ev-table",
  "evcol-at", "evcol-type",
  "fcol-action", "fcol-channel", "fcol-finding", "fcol-issue", "fcol-since",
  "fd-actions", "fd-conn", "fd-events", "fd-impact", "finding-sev-cell",
  "ov-attention", "ov-changed", "ov-events",
  "pm-create", "pm-events",
  "profile-policies", "profile-security", "profile-session",
  "rec-detail", "rec-events",
  "sync-actions", "sync-events", "users-table",
]);

const tokens = new Map(); // token -> Set(files)

for (const file of walk(join(web, "src"))) {
  const text = readFileSync(file, "utf8");
  const re = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1] ?? m[2] ?? "";
    for (const token of raw.split(/[\s\n]+/)) {
      if (!token || token.includes("${") || /[<>{}()]/.test(token)) continue;
      if (!tokens.has(token)) tokens.set(token, new Set());
      tokens.get(token).add(basename(file));
    }
  }
}

/* ------------------------------------------------------- compiled CSS */

const distDir = join(web, "dist", "assets");
let css = "";
try {
  const name = readdirSync(distDir).find((f) => f.endsWith(".css"));
  if (!name) throw new Error("no css in dist/assets");
  css = readFileSync(join(distDir, name), "utf8");
} catch (err) {
  console.error(`Cannot read compiled CSS from ${distDir}: ${err.message}`);
  console.error("Run `npx vite build` first.");
  process.exit(2);
}

/** Mirror Tailwind's selector escaping for the characters we allow. */
const escapeToken = (t) => t.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

/** True when `.token` appears as a complete class selector in the CSS. */
function inCompiled(token) {
  const needle = `.${escapeToken(token)}`;
  let from = 0;
  for (;;) {
    const at = css.indexOf(needle, from);
    if (at === -1) return false;
    const next = css[at + needle.length];
    /* A selector ends at `{` or continues with a separator/combinator or an
       attribute selector. `[` matters: `data-[x]:foo` compiles to
       `.data-\[x\]\:foo[x]`, and omitting it gives a false negative. */
    if (next === undefined || /[{,:>~ )+[\]]/.test(next)) return true;
    from = at + 1;
  }
}

/* ------------------------------------------------------------- report */

const unresolved = [];
const noop = [];
let utility = 0;
let dynamic = 0;

for (const [token, files] of [...tokens].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (DYNAMIC.has(token)) dynamic++;
  else if (inCompiled(token)) utility++;
  else if (KNOWN_NOOP.has(token)) noop.push(token);
  else unresolved.push([token, [...files].join(", ")]);
}

const lines = [];
const say = (s = "") => {
  lines.push(s);
  console.log(s);
};

say(`Classes scanned:       ${tokens.size}`);
say(`  resolved utilities:  ${utility}`);
say(`  dynamic (declared):  ${dynamic}`);
say(`  known no-op hooks:   ${noop.length}`);
say(`  UNRESOLVED:          ${unresolved.length}`);

if (unresolved.length) {
  say("\nUNRESOLVED — no CSS was generated for these (they render as nothing):");
  for (const [t, f] of unresolved) say(`  ${t}  (${f})`);
  /* Written because this shell mangles piped/redirected stdout. */
  writeFileSync(join(web, "scripts", "audit-report.txt"), lines.join("\n") + "\n");
} else {
  say("\nAll classes resolve.");
}

process.exit(unresolved.length ? 1 : 0);
