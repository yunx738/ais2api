'use strict';
// Gateway repair for tool declarations before anything reaches an upstream account.
// Google (especially the legacy proxy path) only accepts an OpenAPI subset:
// upper-case types, no JSON-Schema-only keywords, no type unions.
// Fixable deviations are rewritten; unfixable ones are rejected locally.
const TYPES = new Set(['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'OBJECT']);
const KEEP = new Set(['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required',
  'anyOf', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'title',
  'default', 'example', 'propertyOrdering', 'minProperties', 'maxProperties']);
const {fixSampling} = require('./sampling-limits');
const NAME = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/;
const MAX_DEPTH = 32;
class SanitizeError extends Error {}
const fail = msg => { throw new SanitizeError(msg); };

function schema(input, where, defs, depth, seen) {
  if (depth > MAX_DEPTH) fail(where + ': 参数结构嵌套过深（超过 ' + MAX_DEPTH + ' 层）');
  if (input === true || input === undefined || input === null) return {type: 'STRING'};
  if (typeof input !== 'object' || Array.isArray(input)) fail(where + ': 参数定义必须是对象');
  let s = input;
  if (typeof s.$ref === 'string') {
    const m = s.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
    const target = m && defs[decodeURIComponent(m[1])];
    if (!target) fail(where + ': 无法解析引用 ' + s.$ref);
    if (seen.has(s.$ref)) fail(where + ': 存在循环引用 ' + s.$ref + '，无法展开');
    const {$ref, ...rest} = s;
    return schema({...target, ...rest}, where, defs, depth + 1, new Set([...seen, $ref]));
  }
  if (Array.isArray(s.allOf)) {
    const merged = {...s}; delete merged.allOf;
    for (const part of s.allOf) {
      if (!part || typeof part !== 'object') fail(where + ': allOf 内容无效');
      if (part.properties) merged.properties = {...(merged.properties || {}), ...part.properties};
      if (Array.isArray(part.required)) merged.required = [...(merged.required || []), ...part.required];
      for (const [k, v] of Object.entries(part)) if (!['properties', 'required'].includes(k) && merged[k] === undefined) merged[k] = v;
    }
    s = merged;
  }
  const out = {};
  let type = s.type, nullable = s.nullable === true;
  if (Array.isArray(type)) {
    const real = type.filter(t => String(t).toLowerCase() !== 'null');
    if (real.length !== type.length) nullable = true;
    if (real.length > 1) {
      out.anyOf = real.map(t => schema({...s, type: t, nullable: undefined}, where, defs, depth + 1, seen));
      if (nullable) out.nullable = true;
      if (s.description) out.description = String(s.description);
      return out;
    }
    type = real[0];
  }
  if (s.const !== undefined && s.enum === undefined) s = {...s, enum: [s.const]};
  const variants = s.anyOf || s.oneOf;
  if (Array.isArray(variants)) {
    const list = variants.filter(v => !(v && String(v.type).toLowerCase() === 'null'));
    if (list.length !== variants.length) nullable = true;
    if (!list.length) fail(where + ': anyOf/oneOf 中没有可用类型');
    if (list.length === 1 && type === undefined) return schema({...list[0], description: s.description ?? list[0].description, nullable: nullable || undefined}, where, defs, depth + 1, seen);
    out.anyOf = list.map((v, i) => schema(v, where + '.anyOf[' + i + ']', defs, depth + 1, seen));
  }
  if (type === undefined) type = s.properties ? 'object' : s.items ? 'array' : (out.anyOf ? undefined : 'string');
  if (type !== undefined) {
    const t = String(type).toUpperCase();
    if (!TYPES.has(t)) fail(where + ': 不支持的类型 "' + type + '"');
    out.type = t;
  }
  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k) || k === 'type' || k === 'anyOf' || v === undefined) continue;
    if (k === 'properties') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) fail(where + ': properties 必须是对象');
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = schema(pv, where + '.' + pk, defs, depth + 1, seen);
    } else if (k === 'items') {
      out.items = schema(Array.isArray(v) ? v[0] : v, where + '[]', defs, depth + 1, seen);
    } else if (k === 'required') {
      if (Array.isArray(v)) out.required = [...new Set(v.filter(x => typeof x === 'string'))];
    } else if (k === 'enum') {
      if (!Array.isArray(v) || !v.length) continue;
      const vals = v.filter(x => x !== null);
      if (vals.length !== v.length) nullable = true;
      // Google enums are string-only; keep numeric enums as a hint in the description instead.
      if (out.type === 'STRING' || out.type === undefined) out.enum = vals.map(String);
      else out.description = ((s.description ? s.description + ' ' : '') + '可选值: ' + vals.join(', '));
    } else if (k === 'description' || k === 'title' || k === 'format' || k === 'pattern') {
      if (out[k] === undefined) out[k] = String(v);
    } else if (k === 'nullable') {
      continue;
    } else out[k] = v;
  }
  if (out.type === 'ARRAY' && !out.items) out.items = {type: 'STRING'};
  if (out.required) {
    out.required = out.required.filter(r => out.properties && Object.hasOwn(out.properties, r));
    if (!out.required.length) delete out.required;
  }
  if (out.type === 'OBJECT' && out.properties && !Object.keys(out.properties).length) delete out.properties;
  if (nullable) out.nullable = true;
  return out;
}

function params(p, where) {
  if (p === undefined || p === null) return undefined;
  if (typeof p !== 'object' || Array.isArray(p)) fail(where + ': parameters 必须是对象');
  const defs = {...(p.definitions || {}), ...(p.$defs || {})};
  return schema(p, where, defs, 0, new Set());
}

function checkName(name, where, names) {
  if (typeof name !== 'string' || !NAME.test(name))
    fail(where + ': 工具名 "' + String(name).slice(0, 80) + '" 不合法（只能用字母、数字、_ . -，以字母或下划线开头，最长 64 位）');
  if (names.has(name)) fail(where + ': 工具名 "' + name + '" 重复');
  names.add(name);
}

// Returns {body, changed}. Throws SanitizeError for requests that cannot be repaired.
function sanitizeRequest(route, parsed) {
  const notes = fixSampling(route, parsed);
  let changed = notes.length > 0;
  const names = new Set();
  const fix = (holder, key, where) => {
    const before = JSON.stringify(holder[key]);
    const after = params(holder[key], where);
    if (after === undefined) return;
    if (JSON.stringify(after) !== before) { holder[key] = after; changed = true; }
  };
  if (route === '/v1/chat/completions') {
    if (parsed.tools !== undefined && !Array.isArray(parsed.tools)) fail('tools 必须是数组');
    for (const [i, t] of (parsed.tools || []).entries()) {
      if (!t || t.type !== 'function') continue;
      if (!t.function || typeof t.function !== 'object') fail('tools[' + i + ']: 缺少 function 定义');
      checkName(t.function.name, 'tools[' + i + ']', names);
      fix(t.function, 'parameters', '工具 ' + t.function.name);
      if ('strict' in t.function) { delete t.function.strict; changed = true; }
    }
    for (const [i, f] of (Array.isArray(parsed.functions) ? parsed.functions : []).entries()) {
      checkName(f && f.name, 'functions[' + i + ']', names);
      fix(f, 'parameters', '函数 ' + f.name);
    }
    const rf = parsed.response_format;
    if (rf !== undefined && rf !== null) {
      if (typeof rf !== 'object' || Array.isArray(rf)) fail('response_format 必须是对象');
      if (!['text', 'json_object', 'json_schema'].includes(rf.type)) fail('response_format.type 不支持: ' + String(rf.type).slice(0, 40));
      if (rf.type === 'json_schema') {
        if (!rf.json_schema || typeof rf.json_schema !== 'object' || !rf.json_schema.schema) fail('response_format.json_schema.schema 缺失');
        fix(rf.json_schema, 'schema', 'response_format');
        if ('strict' in rf.json_schema) { delete rf.json_schema.strict; changed = true; }
      }
    }
  } else {
    const gc = parsed.generationConfig || parsed.generation_config;
    if (gc && typeof gc === 'object') {
      for (const k of ['responseJsonSchema', 'response_json_schema']) if (gc[k] !== undefined) {
        if (gc.responseSchema === undefined) gc.responseSchema = gc[k];
        delete gc[k]; changed = true;
      }
      if (gc.response_schema !== undefined && gc.responseSchema === undefined) { gc.responseSchema = gc.response_schema; delete gc.response_schema; changed = true; }
      if (gc.responseSchema !== undefined) fix(gc, 'responseSchema', 'responseSchema');
    }
    if (parsed.tools !== undefined && !Array.isArray(parsed.tools)) fail('tools 必须是数组');
    for (const t of parsed.tools || []) {
      if (!t || typeof t !== 'object') continue;
      for (const key of ['functionDeclarations', 'function_declarations']) {
        for (const [i, d] of (Array.isArray(t[key]) ? t[key] : []).entries()) {
          if (!d || typeof d !== 'object') fail(key + '[' + i + ']: 声明无效');
          checkName(d.name, key + '[' + i + ']', names);
          if (d.parametersJsonSchema !== undefined && d.parameters === undefined) {
            d.parameters = d.parametersJsonSchema; delete d.parametersJsonSchema; changed = true;
          }
          fix(d, 'parameters', '工具 ' + d.name);
        }
      }
    }
  }
  return {body: parsed, changed, notes};
}

module.exports = {sanitizeRequest, SanitizeError};
