#!/usr/bin/env node
// Kontrola shody Make appky a n8n nodu se společnou specifikací mergado-moduly.json.
//
// Použití (z kořene repa make-app-mergado):
//   node scripts/check-parity.mjs [--verbose] [--n8n=../n8n-nodes-mergado]
//
// Bez závislostí. n8n node se čte z buildu (n8n-nodes-mergado/dist), takže před
// spuštěním `npm run build` v n8n-nodes-mergado. Popis nodu se bere přímo z tříd
// (description, routing), trigger a výběry z TS zdrojů.
//
// Co se kontroluje u každé funkce:
// - existence: Make modul (make.name) a n8n operace / event triggeru; n8n: null je
//   povolená výjimka jen s poznámkou (api.call dělá n8n samo přes HTTP Request),
// - metoda a endpoint (parametry v cestě normalizované na {name}),
// - povinné vstupy: vstupy, které se posílají do API (jsou v cestě nebo v request),
//   musí být povinné na obou platformách; nepovinné vstupy z request nesmí být povinné.
//   Ostatní povinné vstupy specifikace (pomocné výběry, např. E-shop před projektem)
//   musí v Make být povinné, v n8n stačí, že existují – n8n je umí obejít zadáním ID,
// - request: parametry body a qs ze specifikace platforma posílá,
// - stránkování a iterace (data), výstupní pole: keyFields v Make interface,
//   computed pole (output_feed_url) dopočítané v Make i v n8n,
// - trigger: log a statusy,
// - výběry (Make RPC, n8n listSearch) a hlavička verze API.
//
// Výstup: tabulka OK / rozdíl, exit code 1 při jakémkoli rozdílu.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Kořen tohoto repa = Make appka; n8n repo je naklonované vedle (../n8n-nodes-mergado),
// jinde ho určí --n8n=<cesta> nebo proměnná N8N_DIR (CI).
const root = path.resolve(here, '..');
const specPath = path.join(root, 'spec', 'mergado-moduly.json');
const makeDir = root;
const n8nArg = process.argv.find((a) => a.startsWith('--n8n='));
const n8nDir = path.resolve(n8nArg ? n8nArg.slice('--n8n='.length) : process.env.N8N_DIR || path.join(root, '..', 'n8n-nodes-mergado'));
const verbose = process.argv.includes('--verbose');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonIf = (file) => (fs.existsSync(file) ? readJson(file) : undefined);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const fmt = (list) => (list.length ? list.join(', ') : '–');

const spec = readJson(specPath);

// ---------- Make ----------

/** `/projects/{{parameters.projectId}}/` -> `/projects/{projectId}/`; přihlášený uživatel -> {userId}. */
function normalizeMakeUrl(url) {
	return url
		.replace(/\{\{\s*parameters\.(\w+)\s*\}\}/g, '{$1}')
		.replace(/\{\{[^}]*connection\.(userId|entityId)[^}]*\}\}/g, '{userId}');
}

/** Rozbalí expect.json včetně vnořených výběrů (options.nested). */
function flattenExpect(params, out = []) {
	for (const p of params ?? []) {
		out.push(p);
		const nested = p.options && !Array.isArray(p.options) ? p.options.nested : undefined;
		if (Array.isArray(nested)) flattenExpect(nested, out);
	}
	return out;
}

function loadMakeModule(name) {
	const dir = path.join(makeDir, 'modules', name);
	if (!fs.existsSync(dir)) return undefined;
	const api = readJsonIf(path.join(dir, 'api.json')) ?? {};
	return {
		module: readJsonIf(path.join(dir, 'module.json')) ?? {},
		api: Array.isArray(api) ? api[0] : api,
		// Statické parametry (parameters.json, např. u triggerů) i mapovatelné vstupy (expect.json).
		expect: flattenExpect([
			...(readJsonIf(path.join(dir, 'parameters.json')) ?? []),
			...(readJsonIf(path.join(dir, 'expect.json')) ?? []),
		]),
		interface: readJsonIf(path.join(dir, 'interface.json')) ?? [],
	};
}

// ---------- n8n ----------

function loadN8n() {
	const dist = path.join(n8nDir, 'dist', 'nodes');
	const nodeFile = path.join(dist, 'Mergado', 'Mergado.node.js');
	if (!fs.existsSync(nodeFile)) {
		throw new Error(`Chybí build n8n nodu (${nodeFile}). Spusť v n8n-nodes-mergado: npm run build`);
	}
	const require = createRequire(nodeFile);
	const { Mergado } = require(nodeFile);
	const { MergadoTrigger } = require(path.join(dist, 'MergadoTrigger', 'MergadoTrigger.node.js'));
	const { MergadoOAuth2Api } = require(
		path.join(n8nDir, 'dist', 'credentials', 'MergadoOAuth2Api.credentials.js'),
	);
	const node = new Mergado();
	return {
		node,
		description: node.description,
		trigger: new MergadoTrigger(),
		credential: new MergadoOAuth2Api(),
		triggerSource: fs.readFileSync(
			path.join(n8nDir, 'nodes', 'MergadoTrigger', 'MergadoTrigger.node.ts'),
			'utf8',
		),
		transportSource: fs.readFileSync(
			path.join(n8nDir, 'nodes', 'Mergado', 'shared', 'transport.ts'),
			'utf8',
		),
	};
}

/** `=/projects/{{$parameter.projectId}}/` -> `/projects/{projectId}/`. */
function normalizeN8nUrl(url) {
	return String(url)
		.replace(/^=/, '')
		.replace(/\{\{\s*\$parameter(?:\.|\[["'])(\w+)(?:["']\])?\s*\}\}/g, '{$1}');
}

function shows(property, resource, operation) {
	const show = property.displayOptions?.show;
	if (!show) return true;
	if (show.resource && !show.resource.includes(resource)) return false;
	if (show.operation && !show.operation.includes(operation)) return false;
	return true;
}

/** Operace n8n: routing z volby operace + viditelné parametry pro resource/operation. */
function findN8nOperation(description, resource, operation) {
	const opProp = description.properties.find(
		(p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes(resource),
	);
	const option = opProp?.options?.find((o) => o.value === operation);
	if (!option) return undefined;
	const params = description.properties.filter(
		(p) => p.name !== 'operation' && p.name !== 'resource' && shows(p, resource, operation),
	);
	// Parametry, které se posílají do API (i uvnitř kolekcí Options).
	const sent = [];
	const collect = (p) => {
		const send = p.routing?.send;
		if (send?.property && (send.type === 'body' || send.type === 'query')) {
			sent.push({ name: p.name, property: send.property, type: send.type, required: !!p.required });
		}
		for (const o of p.type === 'collection' ? (p.options ?? []) : []) collect(o);
	};
	params.forEach(collect);
	return { option, params, sent };
}

// ---------- kontrola ----------

const rows = [];
let failures = 0;

function report(id, platform, problems, note = '') {
	if (problems.length) failures++;
	rows.push({ id, platform, ok: problems.length === 0, problems, note });
}

/** Vstupy ze specifikace rozdělené na ty, které jdou do API, a pomocné. */
function splitInputs(fn, platform) {
	const inputs = (fn.inputs ?? []).filter((i) => !i.platforms || i.platforms.includes(platform));
	const inEndpoint = [...String(fn.endpoint).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
	const inRequest = Object.values({ ...fn.request?.body, ...fn.request?.qs })
		.filter((v) => typeof v === 'string' && v.startsWith('$'))
		.map((v) => v.slice(1).split('|')[0]);
	const apiNames = new Set([...inEndpoint, ...inRequest]);
	return {
		inputs,
		api: inputs.filter((i) => apiNames.has(i.name)),
		helpers: inputs.filter((i) => !apiNames.has(i.name)),
	};
}

function requestKeys(fn) {
	return [
		...Object.keys(fn.request?.body ?? {}).map((k) => `body.${k}`),
		...Object.keys(fn.request?.qs ?? {}).map((k) => `qs.${k}`),
	];
}

function checkMake(fn) {
	if (!fn.make) return report(fn.id, 'Make', [], 've specifikaci bez Make');
	const mod = loadMakeModule(fn.make.name);
	if (!mod) return report(fn.id, 'Make', [`chybí modul modules/${fn.make.name}`]);
	const problems = [];
	const { api } = mod;

	if (fn.make.type === 'universal') return report(fn.id, 'Make', problems, 'universal modul');

	const method = (api.method ?? 'GET').toUpperCase();
	if (method !== fn.method) problems.push(`metoda ${method} ≠ ${fn.method}`);
	const url = normalizeMakeUrl(api.url ?? '');
	if (url !== fn.endpoint) problems.push(`endpoint ${url} ≠ ${fn.endpoint}`);

	const { inputs, api: apiInputs } = splitInputs(fn, 'make');
	// Limit je stránkovací vstup Make (spec: Make Limit / n8n Return All + Limit), do porovnání nepatří.
	const required = mod.expect
		.filter((p) => p.required && !(fn.pagination && p.name === 'limit'))
		.map((p) => p.name);
	const specRequired = inputs.filter((i) => i.required).map((i) => i.name);
	// Make ve specifikaci kopíruje i pomocné výběry, proto se porovnávají všechny povinné vstupy.
	if (!sameSet(required, specRequired)) {
		problems.push(`povinné vstupy [${fmt(required)}] ≠ spec [${fmt(specRequired)}]`);
	}
	const expectNames = mod.expect.map((p) => p.name);
	for (const i of apiInputs) {
		if (!expectNames.includes(i.name)) problems.push(`chybí vstup ${i.name}`);
	}

	for (const key of requestKeys(fn)) {
		const [part, name] = key.split('.');
		const value = part === 'body' ? api.body?.[name] : api.qs?.[name];
		if (value === undefined) problems.push(`neposílá ${key}`);
	}

	if (fn.pagination) {
		const cond = api.pagination?.condition ?? '';
		if (!api.pagination) problems.push('chybí stránkování');
		else if (!cond.includes(`body.${fn.pagination.total}`)) {
			problems.push(`stránkování nekončí podle ${fn.pagination.total}`);
		}
	}
	if (fn.iterate && !JSON.stringify(api.response?.iterate ?? '').includes(`body.${fn.iterate}`)) {
		problems.push(`neiteruje přes ${fn.iterate}`);
	}

	if (fn.trigger) {
		const filter = String(api.qs?.filter ?? '');
		for (const status of fn.trigger.statuses) {
			if (!filter.includes(`"${status}"`)) problems.push(`trigger nefiltruje status ${status}`);
		}
		if (api.qs?.order_by !== fn.trigger.orderBy) problems.push(`order_by ≠ ${fn.trigger.orderBy}`);
		if (!JSON.stringify(api.response?.trigger ?? {}).includes(`item.${fn.trigger.dateField}`)) {
			problems.push(`trigger nehlídá ${fn.trigger.dateField}`);
		}
	}

	const iface = mod.interface.map((f) => f.name);
	const missing = (fn.output?.keyFields ?? []).filter((f) => !iface.includes(f));
	if (missing.length) problems.push(`interface bez polí ${missing.join(', ')}`);
	for (const field of Object.keys(fn.output?.computed ?? {})) {
		if (!JSON.stringify(api.response ?? {}).includes(`"${field}"`)) {
			problems.push(`nedopočítává ${field}`);
		}
	}
	report(fn.id, 'Make', problems, mod.module.label ?? '');
}

function checkN8nTrigger(fn, n8n, target) {
	const problems = [];
	const desc = n8n.trigger.description;
	const event = desc.properties.find((p) => p.name === 'event');
	const option = event?.options?.find((o) => o.value === target.event);
	if (!option) return report(fn.id, 'n8n', [`chybí event ${target.event}`]);
	if (target.name && option.name !== target.name) problems.push(`název ${option.name} ≠ ${target.name}`);

	const m = n8n.triggerSource.match(
		new RegExp(`${target.event}:\\s*\\{\\s*log:\\s*'([^']+)',\\s*statuses:\\s*\\[([^\\]]*)\\]`),
	);
	if (!m) {
		problems.push('nenašel jsem log a statusy eventu v MergadoTrigger.node.ts');
	} else {
		const endpoint = `/projects/{projectId}/${m[1]}/`;
		if (endpoint !== fn.endpoint) problems.push(`endpoint ${endpoint} ≠ ${fn.endpoint}`);
		const statuses = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
		if (!sameSet(statuses, fn.trigger.statuses)) {
			problems.push(`statusy [${fmt(statuses)}] ≠ [${fmt(fn.trigger.statuses)}]`);
		}
	}
	if (!n8n.triggerSource.includes(`order_by: '${fn.trigger.orderBy}'`)) {
		problems.push(`order_by ≠ ${fn.trigger.orderBy}`);
	}
	if (!n8n.triggerSource.includes(fn.trigger.dateField)) problems.push(`nehlídá ${fn.trigger.dateField}`);

	const { api: apiInputs } = splitInputs(fn, 'n8n');
	for (const i of apiInputs.filter((x) => x.required)) {
		const p = desc.properties.find((x) => x.name === i.name);
		if (!p) problems.push(`chybí vstup ${i.name}`);
		else if (!p.required) problems.push(`vstup ${i.name} není povinný`);
	}
	report(fn.id, 'n8n', problems, `MergadoTrigger → ${option.name}`);
}

function checkN8nOperation(fn, n8n, target, problems) {
	const op = findN8nOperation(n8n.description, target.resource, target.operation);
	if (!op) {
		problems.push(`chybí operace ${target.resource} → ${target.operation}`);
		return;
	}
	const label = `${target.resource} → ${op.option.name}`;
	if (target.name && op.option.name !== target.name) problems.push(`${label}: název ≠ ${target.name}`);

	const request = op.option.routing?.request ?? {};
	const method = (request.method ?? 'GET').toUpperCase();
	if (method !== fn.method) problems.push(`${label}: metoda ${method} ≠ ${fn.method}`);
	const url = normalizeN8nUrl(request.url ?? '');
	if (url !== fn.endpoint) problems.push(`${label}: endpoint ${url} ≠ ${fn.endpoint}`);

	const { inputs, api: apiInputs, helpers } = splitInputs(fn, 'n8n');
	const paramNames = op.params.map((p) => p.name);
	for (const i of apiInputs) {
		// Vstup s pevnou hodnotou per operace (Pause / Resume) se v n8n zadává volbou operace.
		if (Array.isArray(fn.n8n) && i.options) continue;
		const p = op.params.find((x) => x.name === i.name) ?? op.sent.find((x) => x.name === i.name);
		if (!p) {
			problems.push(`${label}: chybí vstup ${i.name}`);
			continue;
		}
		if (i.required && !p.required) problems.push(`${label}: vstup ${i.name} není povinný`);
		if (!i.required && p.required) problems.push(`${label}: vstup ${i.name} je povinný, spec ho má nepovinný`);
	}
	for (const i of helpers) {
		if (!paramNames.includes(i.name)) problems.push(`${label}: chybí výběr ${i.name}`);
	}
	const unknownRequired = op.params
		.filter((p) => p.required && !inputs.some((i) => i.name === p.name))
		.map((p) => p.name);
	if (unknownRequired.length) {
		problems.push(`${label}: povinné vstupy navíc proti spec: ${unknownRequired.join(', ')}`);
	}

	for (const key of requestKeys(fn)) {
		const [part, name] = key.split('.');
		const type = part === 'body' ? 'body' : 'query';
		const viaParam = op.sent.some((s) => s.property === name && s.type === type);
		const viaConst = part === 'body' && request.body && name in request.body;
		if (!viaParam && !viaConst) problems.push(`${label}: neposílá ${key}`);
	}
	// Pause / Resume: konstanta v těle odpovídá volbě ze specifikace (Pause = false, Resume = true).
	if (Array.isArray(fn.n8n)) {
		for (const i of inputs.filter((x) => x.options)) {
			const choice = i.options.find((o) => o.label === op.option.name);
			const sentValue = request.body?.[i.name];
			if (choice && sentValue !== choice.value) {
				problems.push(`${label}: posílá ${i.name}=${sentValue}, spec ${choice.value}`);
			}
		}
	}

	const routing = op.option.routing ?? {};
	const postReceive = routing.output?.postReceive ?? [];
	if (fn.iterate) {
		const unwraps = postReceive.some(
			(a) => typeof a === 'object' && a.type === 'rootProperty' && a.properties?.property === fn.iterate,
		);
		if (!unwraps) problems.push(`${label}: nerozbaluje ${fn.iterate}`);
	}
	if (fn.pagination && !op.params.some((p) => p.name === 'returnAll')) {
		problems.push(`${label}: chybí Return All`);
	}
	if (fn.pagination) {
		const returnAll = op.params.find((p) => p.name === 'returnAll');
		const cont = String(returnAll?.routing?.operations?.pagination?.properties?.continue ?? '');
		if (returnAll && !cont.includes(fn.pagination.total)) {
			problems.push(`${label}: stránkování nekončí podle ${fn.pagination.total}`);
		}
	}
	for (const field of Object.keys(fn.output?.computed ?? {})) {
		const computes = postReceive.some((a) => typeof a === 'function' && a.toString().includes(field));
		if (!computes) problems.push(`${label}: nedopočítává ${field}`);
	}
	return label;
}

function checkN8n(fn, n8n) {
	if (fn.n8n === null || fn.n8n === undefined) {
		// Jediná povolená výjimka: obecné API volání, které n8n přidá samo k OAuth2 credentialu.
		const problems = [];
		if (fn.id !== 'api.call') problems.push('ve specifikaci chybí n8n bez zdůvodnění');
		const extendsOAuth2 = (n8n.credential.extends ?? []).includes('oAuth2Api');
		if (fn.id === 'api.call' && !extendsOAuth2) {
			problems.push('credential nedědí z oAuth2Api – n8n nepřidá Custom API Call');
		}
		return report(fn.id, 'n8n', problems, 'výjimka: Custom API Call přidává n8n (HTTP Request + credential)');
	}
	const targets = Array.isArray(fn.n8n) ? fn.n8n : [fn.n8n];
	if (targets[0].node === 'MergadoTrigger') return checkN8nTrigger(fn, n8n, targets[0]);
	const problems = [];
	const labels = targets.map((t) => checkN8nOperation(fn, n8n, t, problems)).filter(Boolean);
	report(fn.id, 'n8n', problems, labels.join(', '));
}

function checkShared(n8n) {
	const problems = [];
	const version = spec.api.headers['use-mergado-api-version'];

	const base = readJsonIf(path.join(makeDir, 'base.json')) ?? {};
	if (base.baseUrl !== spec.api.baseUrl) problems.push(`Make baseUrl ${base.baseUrl} ≠ ${spec.api.baseUrl}`);
	if (base.headers?.['use-mergado-api-version'] !== version) problems.push('Make neposílá hlavičku verze API');
	report('api (verze, baseUrl)', 'Make', problems.splice(0));

	const defaults = n8n.description.requestDefaults ?? {};
	if (defaults.baseURL !== spec.api.baseUrl) problems.push(`baseURL ${defaults.baseURL} ≠ ${spec.api.baseUrl}`);
	if (defaults.headers?.['use-mergado-api-version'] !== version) problems.push('node neposílá hlavičku verze API');
	if (!n8n.transportSource.includes('use-mergado-api-version')) {
		problems.push('pomocné požadavky (výběry, trigger) neposílají hlavičku verze API');
	}
	if (!n8n.transportSource.includes(`'${version}'`)) problems.push(`transport nemá verzi ${version}`);
	report('api (verze, baseUrl)', 'n8n', problems.splice(0));

	// Výběry: Make RPC a n8n listSearch.
	const rpcFor = { shop: 'listShops', project: 'listProjects', rule: 'listRules', pausableRule: 'listPausableRules' };
	const listSearchFor = { shop: 'getShops', project: 'getProjects', rule: 'getRules', pausableRule: 'getRules' };
	const methods = n8n.node.methods?.listSearch ?? {};
	for (const [id, vyber] of Object.entries(spec.vybery)) {
		const rpcDir = path.join(makeDir, 'rpcs', rpcFor[id] ?? id);
		const rpc = readJsonIf(path.join(rpcDir, 'api.json'));
		const make = [];
		if (!rpc) make.push(`chybí RPC ${rpcFor[id] ?? id}`);
		else {
			const url = normalizeMakeUrl(rpc.url ?? '');
			if (url !== vyber.endpoint) make.push(`endpoint ${url} ≠ ${vyber.endpoint}`);
			if (vyber.filter && !JSON.stringify(rpc.response ?? {}).includes(vyber.filter.split(' ')[0])) {
				make.push(`nefiltruje ${vyber.filter}`);
			}
		}
		report(`výběr ${id}`, 'Make', make);

		const fn = methods[listSearchFor[id]];
		const n8nProblems = [];
		if (!fn) n8nProblems.push(`chybí listSearch ${listSearchFor[id]}`);
		else {
			const source = fn.toString();
			const pathRe = vyber.endpoint.replace(/\{\w+\}/g, '${') ;
			const prefix = pathRe.split('${')[0];
			if (!source.includes(prefix)) n8nProblems.push(`nevolá ${vyber.endpoint}`);
			if (vyber.filter && !source.includes(vyber.filter.split(' ')[0])) {
				n8nProblems.push(`nefiltruje ${vyber.filter}`);
			}
		}
		report(`výběr ${id}`, 'n8n', n8nProblems, listSearchFor[id] ?? '');
	}
}

// ---------- běh ----------

let n8n;
try {
	n8n = loadN8n();
} catch (error) {
	console.error(error.message);
	process.exit(2);
}

for (const fn of spec.funkce) {
	checkMake(fn);
	checkN8n(fn, n8n);
}
checkShared(n8n);

const width = Math.max(...rows.map((r) => r.id.length));
console.log(`Shoda Make × n8n se specifikací (${path.relative(root, specPath)})\n`);
for (const r of rows) {
	const status = r.ok ? 'OK     ' : 'ROZDÍL ';
	const head = `${r.id.padEnd(width)}  ${r.platform.padEnd(4)}  ${status}`;
	console.log(r.ok ? `${head}${verbose && r.note ? r.note : ''}` : `${head}${r.problems[0]}`);
	for (const p of r.ok ? [] : r.problems.slice(1)) console.log(`${' '.repeat(head.length)}${p}`);
}
const total = rows.length;
console.log(`\n${total - failures}/${total} OK${failures ? `, ${failures} s rozdílem` : ''}`);
process.exit(failures ? 1 : 0);
