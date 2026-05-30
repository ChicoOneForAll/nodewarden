#!/usr/bin/env node
/**
 * ensure-kv.cjs — make `deploy:kv` idempotent across repeated builds.
 *
 * KV namespaces are referenced in wrangler config by their account-scoped `id`,
 * not by name. The template ships `wrangler.kv.toml` without an id so that a
 * fresh account can auto-provision one on first deploy. However, wrangler's
 * non-interactive provisioning only ever *creates* a namespace, so every build
 * after the first fails with:
 *
 *   ✘ a namespace with this account ID and title already exists [code: 10014]
 *
 * This script runs before `wrangler deploy` and pins a valid id:
 *   - if the config already has an id, it does nothing (respects manual pins);
 *   - otherwise it reuses the existing namespace (matched by title),
 *   - or creates it once, then injects the id into wrangler.kv.toml for this
 *     build. In CI the working tree is ephemeral, so nothing gets committed.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG = path.resolve(__dirname, '..', 'wrangler.kv.toml');
const BINDING = 'ATTACHMENTS_KV';

const wrangler = (args) =>
  execSync(`npx wrangler ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/** Find the [[kv_namespaces]] block for BINDING and report whether it has an id. */
function bindingBlockHasId(toml) {
  const blocks = toml.match(/\[\[kv_namespaces\]\][^[]*/g) || [];
  const block = blocks.find((b) => new RegExp(`binding\\s*=\\s*"${BINDING}"`).test(b));
  return block ? /^\s*id\s*=/m.test(block) : false;
}

/** Expected namespace title, mirroring wrangler's auto-provision naming. */
function expectedTitle(toml) {
  const name = (toml.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1] || 'worker';
  return `${name}-${BINDING.toLowerCase().replace(/_/g, '-')}`;
}

function resolveId(title) {
  const list = JSON.parse(wrangler('kv namespace list'));
  const hit =
    list.find((n) => n.title === title) ||
    list.find((n) => typeof n.title === 'string' && n.title.endsWith('attachments-kv'));
  if (hit) {
    console.log(`[ensure-kv] reusing existing namespace "${hit.title}" (${hit.id})`);
    return hit.id;
  }
  const out = wrangler(`kv namespace create "${title}"`);
  const id = (out.match(/id\s*=\s*"([0-9a-fA-F]{32})"/) || [])[1];
  if (!id) throw new Error(`[ensure-kv] could not parse new namespace id from:\n${out}`);
  console.log(`[ensure-kv] created namespace "${title}" (${id})`);
  return id;
}

function main() {
  let toml = fs.readFileSync(CONFIG, 'utf8');
  if (bindingBlockHasId(toml)) {
    console.log(`[ensure-kv] ${BINDING} already pinned in wrangler.kv.toml — nothing to do`);
    return;
  }
  const id = resolveId(expectedTitle(toml));
  toml = toml.replace(
    new RegExp(`(\\[\\[kv_namespaces\\]\\]\\s*\\n\\s*binding\\s*=\\s*"${BINDING}")`),
    `$1\nid = "${id}"`,
  );
  fs.writeFileSync(CONFIG, toml);
  console.log('[ensure-kv] pinned id into wrangler.kv.toml for this build');
}

main();
