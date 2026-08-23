#!/usr/bin/env node
/**
 * Repair the ESM build of `libsodium-wrappers-sumo`.
 *
 * Upstream ships `dist/modules-sumo-esm/libsodium-wrappers.mjs` containing
 *
 *     import e from "./libsodium-sumo.mjs";
 *
 * but that file is not in this package — it lives in the `libsodium-sumo`
 * dependency, whose own `exports` map resolves the bare specifier correctly.
 * The relative import therefore fails to resolve under Node's ESM loader,
 * under Vite, and under Vitest alike.
 *
 * Rewriting the specifier from the relative path to the package name is the
 * minimal correct fix, and it is idempotent: if the file already imports the
 * package (a newer release, or a second install), nothing happens.
 *
 * See https://github.com/jedisct1/libsodium.js — the `-esm` bundles are built
 * with the relative path baked in.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const BROKEN = './libsodium-sumo.mjs';
const FIXED = 'libsodium-sumo';

function locate() {
  const require = createRequire(import.meta.url);
  try {
    // Resolves to the CJS entry; the ESM sibling sits alongside it.
    const cjs = require.resolve('libsodium-wrappers-sumo');
    const packageRoot = path.resolve(path.dirname(cjs), '..', '..');
    return path.join(
      packageRoot,
      'dist',
      'modules-sumo-esm',
      'libsodium-wrappers.mjs',
    );
  } catch {
    return null;
  }
}

const target = locate();

if (!target || !fs.existsSync(target)) {
  // Nothing installed yet (or a layout we do not recognise). Not an error:
  // postinstall must never fail the install.
  process.exit(0);
}

const source = fs.readFileSync(target, 'utf8');

if (!source.includes(BROKEN)) {
  // Already patched, or upstream fixed it.
  process.exit(0);
}

fs.writeFileSync(target, source.split(BROKEN).join(FIXED), 'utf8');
console.log('patched libsodium-wrappers-sumo ESM entry to import libsodium-sumo');
