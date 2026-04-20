import { defineConfig } from "tsup";

export default defineConfig({
  banner: {
    js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);'
  },
  clean: true,
  format: ["esm"],
  noExternal: ["dotenv", "express", "zod"],
  splitting: false,
  target: "es2022"
});
