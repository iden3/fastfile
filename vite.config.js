import { defineConfig } from "vite";
import { builtinModules } from "module";
import { fileURLToPath } from "url";
import { resolve } from "path";
import { playwright } from "@vitest/browser-playwright";

const root = fileURLToPath(new URL(".", import.meta.url));
const abs = (...parts) => resolve(root, ...parts);

export default defineConfig(({ mode }) => {
    const build = mode === "browser"
        ? {
            lib: {
                entry: "./src/fastfile.browser.js",
                name: "fastfile",
                formats: ["es", "iife"],
                fileName: (format) => format === "es" ? "browser.esm.js" : "browser.iife.js",
            },
            outDir: "build/browser",
            emptyOutDir: true,
        }
        : {
            lib: {
                entry: "./src/fastfile.js",
                formats: ["cjs"],
                fileName: () => "main.cjs",
            },
            outDir: "build/node",
            emptyOutDir: true,
            rollupOptions: {
                external: builtinModules,
            },
        };

    return {
        build,
        test: {
            projects: [
                {
                    // Node — ESM source
                    test: {
                        name: "node-esm",
                        include: ["test/**/*.test.js"],
                        environment: "node",
                        globals: true,
                        testTimeout: 100_000,
                    },
                },
                {
                    // Node — CJS build
                    test: {
                        name: "node-cjs",
                        include: [
                            "test/memfile.test.js",
                            "test/bigmemfile.test.js",
                        ],
                        environment: "node",
                        globals: true,
                        testTimeout: 100_000,
                    },
                    resolve: {
                        alias: [
                            {
                                find: abs("src/fastfile.js"),
                                replacement: abs("build/node/main.cjs"),
                            },
                        ],
                    },
                },
                {
                    // Browser — ESM source inside real Chromium via Playwright
                    test: {
                        name: "browser-esm",
                        include: ["test/fastfile.browser.test.js"],
                        globals: true,
                        browser: {
                            provider: playwright(),
                            enabled: true,
                            instances: [{ browser: "chromium" }],
                        },
                    },
                },
            ],
        },
    };
});
