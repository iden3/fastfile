import js from "@eslint/js";
import globals from "globals";

export default [
    { ignores: ["build/**", "node_modules/**"] },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: {
                ...globals.node,
                ...globals.browser,
            },
        },
        rules: {
            "indent": ["error", 4],
            "linebreak-style": ["warn", "unix"],
            "quotes": ["error", "double"],
            "semi": ["error", "always"],
        },
    },
    {
        // Vitest globals for test files (describe, it, beforeEach, etc.)
        files: ["test/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.mocha,
            },
        },
    },
];
