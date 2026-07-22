// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'jsdom', globals: true },
});
