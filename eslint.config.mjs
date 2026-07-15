import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Supabase Edge Functions laufen unter Deno (eigene Globals wie `Deno`),
    // nicht unter Node/Next.js — daher vom Next-Lint ausgenommen.
    "supabase/functions/**",
    // Unit-Tests laufen über Node (node --test) und brauchen .ts-Endungen in
    // den Imports — vom Next-Lint ausgenommen, damit das nicht kollidiert.
    "**/*.test.ts",
  ]),
]);

export default eslintConfig;
