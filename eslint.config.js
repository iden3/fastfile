import js from "@eslint/js";
import globals from "globals";

export default [
    {
        ignores: ["build/**", "node_modules/**"]
    },
    js.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.es2015,
                ...globals.node,
                ...globals.mocha
            },
            ecmaVersion: 2020,
            sourceType: "module"
        },
        rules: {
            "indent": [
                "error",
                4
            ],
            "linebreak-style": [
                "warn",
                "unix"
            ],
            "quotes": [
                "error",
                "double"
            ],
            "semi": [
                "error",
                "always"
            ],
            "no-unused-vars": ["error", { "caughtErrors": "none" }]
        }
    }
];
