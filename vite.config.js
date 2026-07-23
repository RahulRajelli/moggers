import { defineConfig } from "vite";

/* Explicit config, even though the defaults would do. Without a config file here
   Vite/Vitest walk UP the tree and pick up `D:\Rahul website\vite.config.ts`,
   which loads the React plugin for a project this one has nothing to do with.
   Pinning it keeps builds and tests reproducible. */
export default defineConfig({
  build: {
    /* Never inline assets as data: URIs.
     *
     * Vite inlines anything under 4 kB, which turned several Fontsource subsets
     * into `src: url(data:font/woff2;base64,...)`. The strict CSP sets
     * `font-src 'self'`, so the browser refused them and those subsets silently
     * fell back to a system font — visible in the network panel as FAILED
     * data: requests.
     *
     * The alternative was adding `data:` to font-src, which would weaken the
     * policy for a minor performance win. Emitting real files keeps the policy
     * tight and fixes the rendering bug at the same time. */
    assetsInlineLimit: 0,
    rollupOptions: {
      // Multi-page: the legal pages are real HTML entries so they get the same
      // hashed stylesheet as the app. A <link> to a file in public/ would fork
      // the design tokens, and the strict CSP rules out an inline <style>.
      input: {
        main: "index.html",
        signin: "signin.html",
        privacy: "privacy.html",
        terms: "terms.html",
        resilient: "resilient.html",
        notfound: "404.html",
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
  },
});
