// Uploads the app to Make through the SDK API.
// Usage: node scripts/make.mjs check | deploy | pull
// The token is read from .env or MAKE_API_TOKEN and never printed.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(ROOT, 'make-app.json');

// Settings come from .env locally; in CI the same names come from environment variables.
const ENV_KEYS = ['MAKE_API_TOKEN', 'MAKE_ZONE', 'MAKE_APP_NAME', 'MAKE_APP_VERSION'];
function loadEnv() {
    const env = {};
    const file = join(ROOT, '.env');
    if (existsSync(file)) {
        for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
            if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    }
    for (const key of ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
    if (!env.MAKE_API_TOKEN) throw new Error('MAKE_API_TOKEN is missing: set it in .env (see .env.example) or as an environment variable.');
    return env;
}

const env = loadEnv();
const API = `https://${env.MAKE_ZONE || 'eu1'}.make.com/api/v2`;
const APP = env.MAKE_APP_NAME || 'mergado-wp1zb2';
const VER = env.MAKE_APP_VERSION || '1';

async function call(method, path, body) {
    const res = await fetch(API + path, {
        method,
        headers: {
            authorization: `Token ${env.MAKE_API_TOKEN}`,
            ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, ok: res.ok, data };
}

async function must(method, path, body) {
    const r = await call(method, path, body);
    console.log(`${method} ${path} -> ${r.status}`);
    if (!r.ok) throw new Error(JSON.stringify(r.data, null, 2));
    return r.data;
}

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const loadState = () => (existsSync(STATE_FILE) ? readJson('make-app.json') : {});
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 4) + '\n');

const CONNECTION_SECTIONS = ['api', 'parameters', 'scopes', 'scope'];

async function check() {
    const app = await must('GET', `/sdk/apps/${APP}/${VER}`);
    const { name, label, version, public: isPublic, approved } = app.app || app;
    console.log({ name, label, version, public: isPublic, approved });
    const conns = await must('GET', `/sdk/apps/${APP}/connections`);
    console.log('connections:', (conns.appConnections || []).map((c) => `${c.name} (${c.type})`));
}

async function ensureConnection() {
    const state = loadState();
    if (state.connection) return state.connection;
    const conns = await must('GET', `/sdk/apps/${APP}/connections`);
    let name = (conns.appConnections || [])[0]?.name;
    if (!name) {
        const created = await must('POST', `/sdk/apps/${APP}/connections`, { type: 'oauth', label: 'Mergado' });
        name = (created.appConnection || created).name;
    }
    saveState({ ...state, connection: name });
    return name;
}

async function deploy() {
    // App description and the Docs tab.
    const app = readJson('app.json');
    await must('PATCH', `/sdk/apps/${APP}/${VER}`, { label: app.label, description: app.description });
    const readme = await fetch(`${API}/sdk/apps/${APP}/${VER}/readme`, {
        method: 'PUT',
        headers: { authorization: `Token ${env.MAKE_API_TOKEN}`, 'content-type': 'text/markdown' },
        body: readFileSync(join(ROOT, 'docs', 'make-readme.md'), 'utf8'),
    });
    console.log(`PUT readme -> ${readme.status}`);
    if (!readme.ok) throw new Error(await readme.text());
    const iconFile = join(ROOT, 'assets', 'icon-512.png');
    if (existsSync(iconFile)) {
        const icon = await fetch(`${API}/sdk/apps/${APP}/${VER}/icon`, {
            method: 'PUT',
            headers: { authorization: `Token ${env.MAKE_API_TOKEN}`, 'content-type': 'image/png' },
            body: readFileSync(iconFile),
        });
        console.log(`PUT icon -> ${icon.status}`);
        if (!icon.ok) throw new Error(await icon.text());
    }

    const base = readJson('base.json');
    // Dokumentace uvádí pro nastavení base POST, VS Code rozšíření PUT – zkusíme oba.
    let r = await call('PUT', `/sdk/apps/${APP}/${VER}/base`, base);
    if (r.status === 404 || r.status === 405) r = await call('POST', `/sdk/apps/${APP}/${VER}/base`, base);
    console.log(`base -> ${r.status}`);
    if (!r.ok) throw new Error(JSON.stringify(r.data, null, 2));

    const conn = await ensureConnection();
    for (const section of CONNECTION_SECTIONS) {
        await must('PUT', `/sdk/apps/connections/${conn}/${section}`, readJson(`connections/mergado/${section}.json`));
    }

    // RPCs first – modules reference them in their parameters.
    const existingRpcs = await must('GET', `/sdk/apps/${APP}/${VER}/rpcs`);
    const knownRpcs = new Set((existingRpcs.appRpcs || existingRpcs.rpcs || []).map((r) => r.name));
    for (const name of dirNames('rpcs', 'rpc.json')) {
        const meta = readJson(`rpcs/${name}/rpc.json`);
        if (knownRpcs.has(name)) await must('PATCH', `/sdk/apps/${APP}/${VER}/rpcs/${name}`, { label: meta.label, connection: conn });
        else await must('POST', `/sdk/apps/${APP}/${VER}/rpcs`, { name, label: meta.label, connection: conn });
        for (const section of RPC_SECTIONS) {
            await must('PUT', `/sdk/apps/${APP}/${VER}/rpcs/${name}/${section}`, readJson(`rpcs/${name}/${section}.json`));
        }
    }

    const existing = await must('GET', `/sdk/apps/${APP}/${VER}/modules`);
    const known = new Set((existing.appModules || []).map((m) => m.name));
    for (const name of moduleNames()) {
        const meta = readJson(`modules/${name}/module.json`);
        if (known.has(name)) {
            await must('PATCH', `/sdk/apps/${APP}/${VER}/modules/${name}`,
                { label: meta.label, description: meta.description, connection: conn });
        } else {
            await must('POST', `/sdk/apps/${APP}/${VER}/modules`, { name, ...meta, connection: conn });
        }
        for (const section of moduleSections(name)) {
            await must('PUT', `/sdk/apps/${APP}/${VER}/modules/${name}/${section}`, readJson(`modules/${name}/${section}.json`));
        }
    }
}

const MODULE_SECTIONS = ['api', 'parameters', 'expect', 'interface', 'samples'];
const RPC_SECTIONS = ['api', 'parameters'];
// Polling triggers also have an epoch section ("Choose where to start").
const moduleSections = (name) => [...MODULE_SECTIONS, ...(existsSync(join(ROOT, 'modules', name, 'epoch.json')) ? ['epoch'] : [])];
const dirNames = (dir, marker) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)) : [])
    .filter((n) => existsSync(join(ROOT, dir, n, marker)));
const moduleNames = () => dirNames('modules', 'module.json');

async function pull() {
    // Stáhne aktuální stav z Make do .pull/ pro porovnání s lokálními soubory (common data se nestahují).
    const out = join(ROOT, '.pull');
    mkdirSync(join(out, 'connection'), { recursive: true });
    const base = await must('GET', `/sdk/apps/${APP}/${VER}/base`);
    writeFileSync(join(out, 'base.json'), JSON.stringify(base, null, 4) + '\n');
    const conn = await ensureConnection();
    for (const section of CONNECTION_SECTIONS) {
        const data = await must('GET', `/sdk/apps/connections/${conn}/${section}`);
        writeFileSync(join(out, 'connection', `${section}.json`), JSON.stringify(data, null, 4) + '\n');
    }
    for (const name of moduleNames()) {
        mkdirSync(join(out, 'modules', name), { recursive: true });
        for (const section of moduleSections(name)) {
            const data = await must('GET', `/sdk/apps/${APP}/${VER}/modules/${name}/${section}`);
            writeFileSync(join(out, 'modules', name, `${section}.json`), JSON.stringify(data, null, 4) + '\n');
        }
    }
    console.log(`saved to ${out}`);
}

const cmd = process.argv[2];
const commands = { check, deploy, pull };
if (!commands[cmd]) {
    console.error('Usage: node scripts/make.mjs check | deploy | pull');
    process.exit(1);
}
commands[cmd]().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
