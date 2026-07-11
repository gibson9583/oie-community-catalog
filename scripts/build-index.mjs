#!/usr/bin/env node
/*
 * OIE Community Catalog — index builder & validator.
 *
 * Validates every package manifest under manifests/ and compiles them into the
 * single index.json the Community Store consumes (one conditional GET per sync).
 *
 *   node scripts/build-index.mjs             build index.json (run by CI on merge to main)
 *   node scripts/build-index.mjs --lint      validate manifests only (CI on PRs — the compiled
 *                                            index is CI-owned; submitters never commit it)
 *   node scripts/build-index.mjs --check     validate + fail if index.json is stale (maintainers)
 *   node scripts/build-index.mjs --verify f… additionally download the installer(s) declared in
 *                                            the given version-manifest file(s) and verify sha256
 *
 * Zero dependencies (Node 20+). Layout — one folder per package type:
 *   manifests/<type-dir>/<id>/meta.json        stable package metadata
 *   manifests/<type-dir>/<id>/<version>.json   one immutable manifest per published version
 *   blocklist.json                             repos the store should refuse (propagates in one sync TTL)
 *   index.json                                 compiled output — do not edit by hand
 * <type-dir> is plugins | connectors | datatypes | channels | code-templates |
 * code-template-libraries, and must match the package's meta.json "type".
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = ['plugin', 'connector', 'datatype', 'channel', 'code-template', 'code-template-library'];
const CONTENT_TYPES = ['channel', 'code-template', 'code-template-library'];
// manifests/ folder name per package type — the folder a package lives in must match its meta.json type.
const TYPE_DIRS = {
    plugins: 'plugin', connectors: 'connector', datatypes: 'datatype',
    channels: 'channel', 'code-templates': 'code-template', 'code-template-libraries': 'code-template-library',
};
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_RE = /^[0-9]+(\.[0-9]+)*([.-][0-9A-Za-z.-]+)?$/;
const MAX_VERIFY_BYTES = 250 * 1024 * 1024;

const errors = [];
const fail = (m) => errors.push(m);

function readJson(path) {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { fail(`${path}: invalid JSON — ${e.message}`); return null; }
}

function requireFields(obj, fields, where) {
    for (const [key, type] of fields) {
        const v = obj[key];
        if (v === undefined || v === null || (type === 'string' && String(v).trim() === '')) {
            fail(`${where}: missing required field "${key}"`);
        } else if (type === 'string' && typeof v !== 'string') fail(`${where}: "${key}" must be a string`);
        else if (type === 'boolean' && typeof v !== 'boolean') fail(`${where}: "${key}" must be a boolean`);
        else if (type === 'array' && !Array.isArray(v)) fail(`${where}: "${key}" must be an array`);
    }
}

function httpsUrl(value, where, field) {
    try { const u = new URL(value); if (u.protocol !== 'https:') fail(`${where}: ${field} must be https`); }
    catch { fail(`${where}: ${field} is not a valid URL`); }
}

// semver-ish descending compare (numeric segments, then string)
function cmpVersion(a, b) {
    const pa = String(a).split(/[.-]/), pb = String(b).split(/[.-]/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = parseInt(pa[i] ?? '0', 10), nb = parseInt(pb[i] ?? '0', 10);
        if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return nb - na;
        if ((pa[i] ?? '') !== (pb[i] ?? '')) return (pb[i] ?? '').localeCompare(pa[i] ?? '');
    }
    return 0;
}

function loadPackages() {
    const manifestsDir = join(ROOT, 'manifests');
    const packages = [];
    const ids = new Set();
    for (const typeDir of readdirSync(manifestsDir).sort()) {
        const typePath = join(manifestsDir, typeDir);
        if (!statSync(typePath).isDirectory()) continue;
        if (!(typeDir in TYPE_DIRS)) {
            fail(`manifests/${typeDir}: unknown type folder — expected one of ${Object.keys(TYPE_DIRS).join(', ')}`);
            continue;
        }
        const expectedType = TYPE_DIRS[typeDir];
        for (const id of readdirSync(typePath).sort()) {
            const dir = join(typePath, id);
            if (!statSync(dir).isDirectory()) continue;
            const where = `manifests/${typeDir}/${id}`;
            if (!ID_RE.test(id)) fail(`${where}: directory name is not a valid package id (lowercase, digits, hyphens)`);
            if (ids.has(id)) fail(`${where}: duplicate package id`);
            ids.add(id);

            loadPackage(dir, where, id, expectedType, packages);
        }
    }
    return packages;
}

function loadPackage(dir, where, id, expectedType, packages) {
    {
        const meta = readJson(join(dir, 'meta.json'));
        if (!meta) return;
        requireFields(meta, [['id', 'string'], ['name', 'string'], ['description', 'string'], ['type', 'string'],
            ['publisher', 'string'], ['repository', 'string'], ['license', 'string']], `${where}/meta.json`);
        if (meta.id !== id) fail(`${where}/meta.json: "id" (${meta.id}) must equal the directory name`);
        if (!TYPES.includes(meta.type)) fail(`${where}/meta.json: unknown type "${meta.type}"`);
        if (meta.type !== expectedType) fail(`${where}/meta.json: type "${meta.type}" does not match its folder (expected "${expectedType}")`);
        if (meta.repository) httpsUrl(meta.repository, `${where}/meta.json`, 'repository');
        if (CONTENT_TYPES.includes(meta.type)) {
            if (!meta.contentId || !UUID_RE.test(meta.contentId)) {
                fail(`${where}/meta.json: content packages require a uuid "contentId" (the engine id of the artifact)`);
            }
        }

        const versions = [];
        for (const file of readdirSync(dir).sort()) {
            if (file === 'meta.json' || !file.endsWith('.json')) continue;
            const vWhere = `${where}/${file}`;
            const v = readJson(join(dir, file));
            if (!v) continue;
            requireFields(v, [['version', 'string'], ['installerUrl', 'string'], ['sha256', 'string'],
                ['restartRequired', 'boolean']], vWhere);
            if (v.version && file !== `${v.version}.json`) fail(`${vWhere}: filename must be <version>.json (${v.version})`);
            if (v.version && !VERSION_RE.test(v.version)) fail(`${vWhere}: "version" is not a comparable version string`);
            if (v.sha256 && !SHA256_RE.test(v.sha256)) fail(`${vWhere}: "sha256" must be 64 lowercase hex chars`);
            if (v.installerUrl) httpsUrl(v.installerUrl, vWhere, 'installerUrl');
            if (v.docsUrl) httpsUrl(v.docsUrl, vWhere, 'docsUrl');
            // `ui` (optional) is declared in the plugin's oie.json and carried into the version
            // manifest by the publisher's release workflow; it flows into index.json verbatim.
            // Constrain the shape so a malformed value is rejected rather than shipped.
            if (v.ui !== undefined && (!Array.isArray(v.ui)
                    || v.ui.some((s) => s !== 'web' && s !== 'swing')
                    || new Set(v.ui).size !== v.ui.length)) {
                fail(`${vWhere}: "ui" must be an array of unique surfaces from {"web","swing"}`);
            }
            versions.push(v);
        }
        if (versions.length === 0) fail(`${where}: no version manifests`);
        versions.sort((a, b) => cmpVersion(a.version, b.version));
        packages.push({ ...meta, versions });
    }
}

function buildIndex(packages) {
    const blocklistPath = join(ROOT, 'blocklist.json');
    const blocklist = existsSync(blocklistPath) ? readJson(blocklistPath) ?? [] : [];
    if (!Array.isArray(blocklist)) fail('blocklist.json: must be a JSON array of "owner/repository" strings');
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        packages,
        blocklist,
    };
}

async function verifyDigests(files) {
    for (const file of files) {
        if (!file.endsWith('.json') || file.endsWith('meta.json') || !file.includes('manifests/')) continue;
        const path = join(ROOT, file.replace(`${ROOT}/`, ''));
        if (!existsSync(path)) continue; // deleted in the PR
        const v = readJson(path);
        if (!v || !v.installerUrl || !v.sha256) continue;
        process.stdout.write(`verify ${file} … `);
        const res = await fetch(v.installerUrl, { redirect: 'follow' });
        if (!res.ok) { fail(`${file}: installerUrl fetch failed (HTTP ${res.status})`); console.log('FAIL'); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_VERIFY_BYTES) { fail(`${file}: artifact exceeds verify cap`); console.log('FAIL'); continue; }
        const actual = createHash('sha256').update(buf).digest('hex');
        if (actual !== v.sha256.toLowerCase()) {
            fail(`${file}: sha256 mismatch — manifest ${v.sha256}, artifact ${actual}`);
            console.log('MISMATCH');
        } else console.log(`ok (${buf.length} bytes)`);
    }
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const lint = args.includes('--lint');
const verifyIdx = args.indexOf('--verify');

const packages = loadPackages();
const index = buildIndex(packages);

if (verifyIdx >= 0) {
    await verifyDigests(args.slice(verifyIdx + 1));
}

if (errors.length) {
    console.error(`\n${errors.length} problem(s):`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
}

const out = JSON.stringify(index, null, 2) + '\n';
const indexPath = join(ROOT, 'index.json');

if (lint) {
    // PR mode: manifests must be valid (and digests, when --verify ran), but the
    // compiled index is CI-owned — submitters never touch index.json.
    console.log(`ok — ${packages.length} package(s) valid.`);
} else if (check) {
    const strip = (s) => s.replace(/"generatedAt": "[^"]*"/, '"generatedAt": ""');
    const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
    if (strip(current) !== strip(out)) {
        console.error('index.json is stale — run `node scripts/build-index.mjs` and commit the result.');
        process.exit(1);
    }
    console.log(`ok — ${packages.length} package(s) valid, index.json up to date.`);
} else {
    writeFileSync(indexPath, out);
    console.log(`wrote index.json — ${packages.length} package(s), ${index.blocklist.length} blocklist entr(ies).`);
}
