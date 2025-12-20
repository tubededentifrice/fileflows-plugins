import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

export default [
    js.configs.recommended,
    prettier,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                Logger: 'readonly',
                Variables: 'readonly',
                Flow: 'readonly',
                http: 'readonly',
                Sleep: 'readonly',
                MissingVariable: 'readonly',
                LanguageHelper: 'readonly',
                JsonContent: 'readonly',
                System: 'readonly',
                vi: 'readonly',
                video: 'readonly',
                ExecuteArgs: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': [
                'warn',
                {
                    vars: 'all',
                    args: 'after-used',
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^(?:Script|_.*)$',
                    caughtErrors: 'all',
                    caughtErrorsIgnorePattern: '^(?:_|e|err|error|err2|err3|err4|errS|e2)$',
                    ignoreRestSiblings: true
                }
            ],
            'no-undef': 'error',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-useless-escape': 'error'
        }
    }
];
