// Generates the Make RPCs and modules from the shared spec spec/mergado-moduly.json.
// Output interfaces come from the Mergado OpenAPI spec the shared spec points to, so they match real responses.
// Usage: node scripts/generate.mjs [path/to/mergado-moduly.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = process.argv[2] || join(APP_ROOT, 'spec', 'mergado-moduly.json');
const shared = JSON.parse(readFileSync(specPath, 'utf8'));
const openapi = JSON.parse(readFileSync(join(dirname(specPath), shared.api.openapi), 'utf8'));

// --- OpenAPI → Make interface ------------------------------------------------------------------
const deref = (o) => {
    if (o && o.$ref) {
        let x = openapi;
        for (const k of o.$ref.replace('#/', '').split('/')) x = x[k];
        return deref(x);
    }
    return o;
};
const merge = (sc) => {
    sc = deref(sc);
    if (sc && sc.allOf) return { type: 'object', properties: Object.assign({}, ...sc.allOf.map(merge).map((s) => s.properties || {})) };
    return sc;
};
function outputSchema({ path, method, item }) {
    const r = deref(openapi.paths[path][method].responses['200'] || openapi.paths[path][method].responses['201']);
    const sc = merge(Object.values(r.content)[0].schema);
    return item ? merge(merge(sc.properties.data).items) : sc;
}

// Element names differ per project, so the spec's sample elements must not become fixed fields.
const FREE_FORM = ['elements', 'attributes', 'extracted_values'];
const LABELS = { id: 'ID', url: 'URL', xml_domain: 'XML domain', web: 'Website', output_feed_url: 'Output feed URL' };
const label = (name) => LABELS[name] || (name.charAt(0).toUpperCase() + name.slice(1)).replace(/_/g, ' ').replace(/\bid\b/g, 'ID').replace(/\burl\b/g, 'URL');
const isDate = (name, s) => s.format === 'date-time' || /(_at|^created|^last_access|_validity)$/.test(name);

function toInterface(schema, depth = 0) {
    schema = merge(schema);
    return Object.entries(schema.properties || {}).map(([name, raw]) => field(name, raw, depth));
}
function field(name, raw, depth) {
    const s = merge(raw) || {};
    const f = { name, label: label(name) };
    if (s.type === 'array') {
        f.type = 'array';
        const it = merge(s.items);
        if (it && it.properties && depth < 2) f.spec = { type: 'collection', spec: toInterface(it, depth + 1) };
        else if (it && it.type && it.type !== 'object') f.spec = { type: it.type === 'string' ? 'text' : it.type === 'integer' ? 'number' : it.type };
    } else if (s.type === 'object' || s.properties) {
        f.type = 'collection';
        if (s.properties && depth < 2 && !FREE_FORM.includes(name)) f.spec = toInterface(s, depth + 1);
    } else if (s.type === 'boolean') f.type = 'boolean';
    else if (s.type === 'number' || s.type === 'integer') f.type = 'number';
    else f.type = isDate(name, s) ? 'date' : 'text';
    return f;
}

// --- shared spec → Make IML ----------------------------------------------------------------------
const P = (name) => `parameters.${name}`;
// {userId} is the signed-in user stored by the connection; every other {param} is a module input.
const url = (endpoint) => endpoint
    .replace('{userId}', '{{ifempty(connection.userId, connection.entityId)}}')
    .replace(/\{(\w+)\}/g, (_, n) => `{{${P(n)}}}`);
// "{name|element_path|id} ({type}, active|paused)" → IML label
const chain = (fields) => fields.slice(0, -1).reduceRight((acc, f) => `ifempty(item.${f}, ${acc})`, `item.${fields[fields.length - 1]}`);
const pickerLabel = (tpl) => tpl
    .replace(/\{([^}]+)\}/g, (_, f) => `{{${chain(f.split('|'))}}}`)
    .replace('active|paused', "{{if(item.applies, 'active', 'paused')}}");

function requestValue(value, inputs) {
    if (typeof value !== 'string' || !value.startsWith('$')) return value;
    const [name, transform] = value.slice(1).split('|');
    const input = inputs.find((i) => i.name === name);
    // "ITEM_ID, PRICE_VAT" → ["ITEM_ID","PRICE_VAT"]; spaces around commas are dropped, spaces inside paths kept.
    if (transform === 'csvJsonArray') {
        return `{{if(${P(name)}, '["' + join(split(replace(${P(name)}, '/\\s*,\\s*/g', ','), ','), '","') + '"]', undefined)}}`;
    }
    return input && input.required ? `{{${P(name)}}}` : `{{ifempty(${P(name)}, undefined)}}`;
}
const forMake = (input) => !input.platforms || input.platforms.includes('make');
// Request values that refer to an input Make doesn't have are left out.
const mapValues = (obj, inputs) => obj && Object.fromEntries(Object.entries(obj)
    .filter(([, v]) => typeof v !== 'string' || !v.startsWith('$') || inputs.some((i) => i.name === v.slice(1).split('|')[0] && forMake(i)))
    .map(([k, v]) => [k, requestValue(v, inputs)]));

const RPC_NAMES = {};
const rpcName = (pickerId) => (RPC_NAMES[pickerId] ||= `list${pickerId.charAt(0).toUpperCase()}${pickerId.slice(1)}${pickerId.endsWith('s') ? '' : 's'}`);

function makeParam(input) {
    const p = { name: input.name, type: input.type, label: input.label };
    if (input.required) p.required = true;
    if (input.help) p.help = input.help;
    if (input.options) p.options = input.options;
    if (input.type === 'array') p.spec = { type: 'text', label: input.label.replace(/s$/, '') };
    if (input.source) {
        const pickerId = input.source.replace('vyber:', '');
        p.type = 'select';
        p.options = `rpc://${rpcName(pickerId)}`;
        // A picker field without its own help gets the picker's help text.
        if (!p.help && shared.vybery[pickerId].help) p.help = shared.vybery[pickerId].help;
    }
    return p;
}
// Picker selects nest (e-shop → project → rule), so each one appears once its parent is chosen.
function makeParams(inputs) {
    const pickers = inputs.filter((i) => i.source).map(makeParam);
    const rest = inputs.filter((i) => !i.source).map(makeParam);
    for (let i = pickers.length - 2; i >= 0; i--) {
        pickers[i].options = { store: pickers[i].options, nested: [pickers[i + 1]] };
    }
    return [...pickers.slice(0, 1), ...rest];
}
const limitParam = (what, trigger) => ({
    name: 'limit', type: 'uinteger', label: 'Limit',
    default: trigger ? 2 : 10,
    ...(trigger && { required: true }),
    help: `Maximum number of ${what} Make will return during one execution cycle.`,
});

function computedOutput(schema, computed, src) {
    const out = Object.fromEntries(Object.keys(schema.properties || {}).map((k) => [k, `{{${src}.${k}}}`]));
    for (const [k, tpl] of Object.entries(computed)) out[k] = tpl.replace(/\{(\w+)\}/g, (_, f) => `{{${src}.${f}}}`);
    return out;
}

function buildModule(fn) {
    const schema = outputSchema(fn.output.schema);
    const computed = fn.output.computed || {};
    const isList = Boolean(fn.iterate);
    const src = isList ? 'item' : 'body';
    const output = Object.keys(computed).length ? computedOutput(schema, computed, src) : `{{${src}}}`;
    const req = fn.request || {};
    const api = { url: url(fn.endpoint), method: fn.method };
    const qs = { ...(fn.pagination && { limit: fn.pagination.pageSize }), ...mapValues(req.qs, fn.inputs) };
    if (fn.trigger) {
        qs.order_by = fn.trigger.orderBy;
        qs.filter = JSON.stringify([{ field: 'status', op: 'in', value: fn.trigger.statuses }]);
    }
    if (Object.keys(qs).length) api.qs = qs;
    if (req.body) { api.type = 'json'; api.body = mapValues(req.body, fn.inputs); }
    api.response = {
        ...(isList && { iterate: `{{body.${fn.iterate}}}` }),
        output,
        ...((fn.make.type === 'search' || fn.make.type === 'trigger') && { limit: '{{parameters.limit}}' }),
        ...(fn.trigger && { trigger: { id: '{{item.id}}', date: `{{item.${fn.trigger.dateField}}}`, type: 'date', order: 'desc' } }),
    };
    if (fn.pagination) {
        const page = fn.pagination.pageSize;
        api.pagination = {
            qs: { offset: `{{(pagination.page - 1) * ${page}}}` },
            condition: `{{body.offset + body.limit < body.${fn.pagination.total}}}`,
        };
    }
    const what = fn.make.label.replace(/^(List|Search|Watch( Failed)?) /, '').toLowerCase();
    const params = makeParams(fn.inputs.filter(forMake));
    const typeId = { search: 9, action: 4, trigger: 1, universal: 12 }[fn.make.type];
    const iface = [...toInterface(schema), ...Object.keys(computed).map((k) => ({ name: k, label: label(k), type: 'url' }))];
    return {
        meta: { label: fn.make.label, description: fn.make.description, typeId },
        api,
        // Triggers only take static parameters; everything else is mappable.
        parameters: fn.make.type === 'trigger' ? [...params, limitParam(what, true)] : [],
        expect: fn.make.type === 'trigger' ? [] : [...params, ...(fn.make.type === 'search' ? [limitParam(what)] : [])],
        interface: iface,
        ...(fn.trigger && {
            epoch: { response: { limit: 300, output: { label: `{{formatDate(item.${fn.trigger.dateField}, 'YYYY-MM-DD HH:mm')}} – {{item.status}}`, date: `{{item.${fn.trigger.dateField}}}` } } },
        }),
    };
}

function buildRpc(id, picker) {
    const api = {
        url: url(picker.endpoint), method: 'GET',
        response: {
            iterate: picker.filter ? { container: '{{body.data}}', condition: `{{item.${picker.filter}}}` } : '{{body.data}}',
            output: { label: pickerLabel(picker.label), value: `{{item.${picker.value}}}` },
            ...(picker.limit && { limit: picker.limit }),
        },
    };
    // Rules come back all at once without `limit`; shops and projects are paged.
    if (id === 'shop' || id === 'project') {
        api.qs = { limit: 100 };
        api.pagination = { qs: { offset: '{{(pagination.page - 1) * 100}}' }, condition: '{{body.offset + body.limit < body.total_results}}' };
    }
    return { label: `List ${id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}s`, api };
}

// --- write ---------------------------------------------------------------------------------------
const write = (rel, data) => {
    const file = join(APP_ROOT, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 4) + '\n');
};
const generated = shared.funkce.filter((fn) => fn.make && fn.make.type !== 'universal');
for (const fn of generated) {
    const m = buildModule(fn);
    const dir = `modules/${fn.make.name}`;
    write(`${dir}/module.json`, m.meta);
    write(`${dir}/api.json`, m.api);
    write(`${dir}/parameters.json`, m.parameters);
    write(`${dir}/expect.json`, m.expect);
    write(`${dir}/interface.json`, m.interface);
    write(`${dir}/samples.json`, {});
    if (m.epoch) write(`${dir}/epoch.json`, m.epoch);
}
for (const [id, picker] of Object.entries(shared.vybery)) {
    const r = buildRpc(id, picker);
    write(`rpcs/${rpcName(id)}/rpc.json`, { label: r.label });
    write(`rpcs/${rpcName(id)}/api.json`, r.api);
    write(`rpcs/${rpcName(id)}/parameters.json`, []);
}
// The base carries the API version header for every module and RPC.
write('app.json', { label: shared.app.label, description: shared.app.description });
const base = JSON.parse(readFileSync(join(APP_ROOT, 'base.json'), 'utf8'));
base.headers = { ...base.headers, ...shared.api.headers };
write('base.json', base);

console.log('modules:', generated.map((f) => f.make.name).join(', '));
console.log('rpcs:', Object.keys(shared.vybery).map(rpcName).join(', '));
