'use strict';

/**
 * 入力型の単一定義から Wire 用 JSON Schema と型宣言を生成する。
 *
 *   node scripts/generate-input-types.js
 *   node scripts/generate-input-types.js --check
 */

const fs = require('fs');
const path = require('path');
const { definitions, roots } = require('./lib/input-types/definitions.js');

const REPO_ROOT = path.join(__dirname, '..');
const SCHEMA_DIR = path.join(REPO_ROOT, 'data', 'tax-simulator', 'schemas', 'input');
const DECLARATION_FILE = path.join(
  REPO_ROOT,
  'scripts',
  'lib',
  'input-types',
  'generated',
  'input-types.d.ts'
);
const CHECK_ONLY = process.argv.includes('--check');

function indented(text, spaces) {
  const prefix = ' '.repeat(spaces);
  return text.split('\n').map(line => prefix + line).join('\n');
}

function typeName(name, wire, parameters) {
  if (parameters.has(name)) return name;
  return wire ? `${name}Wire` : name;
}

function typescriptType(node, wire, parameters = new Set(), depth = 0) {
  switch (node.kind) {
    case 'string': return 'string';
    case 'boolean': return 'boolean';
    case 'integer': return 'number';
    case 'bigint': return wire ? 'Decimal' : 'bigint';
    case 'brandedString': {
      const brand = wire ? `${node.brand}Wire` : node.brand;
      return `string & { readonly ${brand}: unique symbol }`;
    }
    case 'literal': return JSON.stringify(node.value);
    case 'enum': return node.values.map(value => JSON.stringify(value)).join(' | ');
    case 'ref': return typeName(node.name, wire, parameters);
    case 'array': {
      const item = typescriptType(node.items, wire, parameters, depth);
      return `Array<${item}>`;
    }
    case 'record':
      return `Partial<Record<string, ${typescriptType(node.values, wire, parameters, depth)}>>`;
    case 'genericRef': {
      const args = node.arguments.map(argument => typescriptType(argument, wire, parameters, depth));
      return `${typeName(node.name, wire, parameters)}<${args.join(', ')}>`;
    }
    case 'union':
      return node.variants
        .map(variant => typescriptType(variant, wire, parameters, depth))
        .join(' | ');
    case 'intersection':
      return node.parts
        .map(part => typescriptType(part, wire, parameters, depth))
        .join(' & ');
    case 'object': {
      const lines = [];
      for (const [name, property] of Object.entries(node.required)) {
        lines.push(`${name}: ${typescriptType(property, wire, parameters, depth + 1)};`);
      }
      for (const [name, property] of Object.entries(node.optional)) {
        lines.push(`${name}?: ${typescriptType(property, wire, parameters, depth + 1)};`);
      }
      const body = lines.length === 0
        ? '{}'
        : `{\n${indented(lines.join('\n'), (depth + 1) * 2)}\n${' '.repeat(depth * 2)}}`;
      if (!node.bases || node.bases.length === 0) return body;
      const bases = node.bases.map(name => typeName(name, wire, parameters));
      return [...bases, body].join(' & ');
    }
    default:
      throw new Error(`型宣言へ変換できない定義種別です: ${node.kind}`);
  }
}

function renderDeclaration() {
  const lines = [
    '/**',
    ' * このファイルは scripts/lib/input-types/definitions.js から自動生成しています。',
    ' * 直接編集せず、npm run input-types:generate を実行してください。',
    ' */',
    '',
  ];

  const decimal = definitions.Decimal;
  lines.push(`export type Decimal = ${typescriptType(decimal, false)};`, '');

  lines.push('// メモリ内表現。正確な値は bigint で保持する。', '');
  for (const [name, node] of Object.entries(definitions)) {
    if (node.wireOnly) continue;
    const parameters = new Set(node.parameters || []);
    const generic = node.parameters ? `<${node.parameters.join(', ')}>` : '';
    lines.push(`export type ${name}${generic} = ${typescriptType(node, false, parameters)};`, '');
  }

  lines.push('// 外部形式。bigint に対応する値は Decimal で保持する。', '');
  for (const [name, node] of Object.entries(definitions)) {
    if (node.wireOnly) continue;
    const parameters = new Set(node.parameters || []);
    const generic = node.parameters ? `<${node.parameters.join(', ')}>` : '';
    lines.push(`export type ${name}Wire${generic} = ${typescriptType(node, true, parameters)};`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function resolveReference(name, substitutions) {
  if (substitutions.has(name)) return substitutions.get(name);
  const definition = definitions[name];
  if (!definition) throw new Error(`参照先の型定義がありません: ${name}`);
  return definition;
}

function mergeObjectShape(target, source) {
  Object.assign(target.properties, source.properties);
  for (const name of source.required) target.required.add(name);
}

function objectShape(node, substitutions = new Map(), seen = new Set()) {
  if (node.kind === 'ref') {
    if (substitutions.has(node.name)) return objectShape(substitutions.get(node.name), substitutions, seen);
    if (seen.has(node.name)) throw new Error(`オブジェクト継承が循環しています: ${node.name}`);
    const nextSeen = new Set(seen);
    nextSeen.add(node.name);
    return objectShape(resolveReference(node.name, substitutions), substitutions, nextSeen);
  }
  if (node.kind === 'intersection') {
    const result = { properties: {}, required: new Set() };
    for (const part of node.parts) mergeObjectShape(result, objectShape(part, substitutions, seen));
    return result;
  }
  if (node.kind !== 'object') {
    throw new Error(`閉じたオブジェクトとして統合できない定義種別です: ${node.kind}`);
  }

  const result = { properties: {}, required: new Set() };
  for (const base of node.bases || []) {
    mergeObjectShape(result, objectShape({ kind: 'ref', name: base }, substitutions, seen));
  }
  for (const [name, property] of Object.entries(node.required)) {
    result.properties[name] = schemaType(property, substitutions);
    result.required.add(name);
  }
  for (const [name, property] of Object.entries(node.optional)) {
    result.properties[name] = schemaType(property, substitutions);
  }
  return result;
}

function closedObjectSchema(node, substitutions) {
  const shape = objectShape(node, substitutions);
  const schema = {
    type: 'object',
    properties: shape.properties,
  };
  if (shape.required.size > 0) schema.required = [...shape.required];
  schema.additionalProperties = false;
  return schema;
}

function schemaType(node, substitutions = new Map()) {
  switch (node.kind) {
    case 'string': return { type: 'string' };
    case 'boolean': return { type: 'boolean' };
    case 'integer': return { type: 'integer' };
    case 'bigint': return {
      type: 'string',
      pattern: node.positive ? '^[1-9][0-9]*$' : '^-?[0-9]+$',
      description: node.positive
        ? '正の整数を表すDecimal。指数表記と桁区切りは不可。'
        : '整数を表すDecimal。指数表記と桁区切りは不可。',
    };
    case 'brandedString': {
      const schema = { type: 'string', pattern: node.pattern };
      if (node.description) schema.description = node.description;
      return schema;
    }
    case 'literal': return { const: node.value };
    case 'enum': return { enum: node.values };
    case 'ref': {
      if (substitutions.has(node.name)) return schemaType(substitutions.get(node.name), substitutions);
      return { $ref: `#/$defs/${node.name}Wire` };
    }
    case 'array': return { type: 'array', items: schemaType(node.items, substitutions) };
    case 'record': return {
      type: 'object',
      additionalProperties: schemaType(node.values, substitutions),
    };
    case 'genericRef': {
      const generic = resolveReference(node.name, substitutions);
      if (!generic.parameters || generic.parameters.length !== node.arguments.length) {
        throw new Error(`型引数の数が一致しません: ${node.name}`);
      }
      const next = new Map(substitutions);
      generic.parameters.forEach((parameter, index) => next.set(parameter, node.arguments[index]));
      return schemaType(generic, next);
    }
    case 'union': return { oneOf: node.variants.map(variant => schemaType(variant, substitutions)) };
    case 'intersection': return closedObjectSchema(node, substitutions);
    case 'object': return closedObjectSchema(node, substitutions);
    default:
      throw new Error(`JSON Schemaへ変換できない定義種別です: ${node.kind}`);
  }
}

function collectReachable(rootName) {
  const names = new Set();
  const visiting = new Set();

  function visitNode(node, parameters = new Set()) {
    switch (node.kind) {
      case 'ref':
        if (!parameters.has(node.name)) visitName(node.name);
        break;
      case 'genericRef':
        visitName(node.name);
        node.arguments.forEach(argument => visitNode(argument, parameters));
        break;
      case 'array':
        visitNode(node.items, parameters);
        break;
      case 'record':
        visitNode(node.values, parameters);
        break;
      case 'union':
        node.variants.forEach(variant => visitNode(variant, parameters));
        break;
      case 'intersection':
        node.parts.forEach(part => visitNode(part, parameters));
        break;
      case 'object':
        (node.bases || []).forEach(visitName);
        Object.values(node.required).forEach(property => visitNode(property, parameters));
        Object.values(node.optional).forEach(property => visitNode(property, parameters));
        break;
      default:
        break;
    }
  }

  function visitName(name) {
    if (names.has(name) || visiting.has(name)) return;
    const node = definitions[name];
    if (!node) throw new Error(`参照先の型定義がありません: ${name}`);
    visiting.add(name);
    names.add(name);
    visitNode(node, new Set(node.parameters || []));
    visiting.delete(name);
  }

  visitName(rootName);
  return [...names].filter(name => !definitions[name].parameters && !definitions[name].wireOnly);
}

function renderSchema(root) {
  const defs = {};
  for (const name of collectReachable(root.name)) {
    defs[`${name}Wire`] = schemaType(definitions[name]);
  }
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: root.file,
    title: root.title,
    description: '入力型設計書 §3〜§7 に基づくWire形式。自動生成物。',
    $ref: `#/$defs/${root.name}Wire`,
    $defs: defs,
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

function expectedOutputs() {
  const outputs = new Map([[DECLARATION_FILE, renderDeclaration()]]);
  for (const root of roots) outputs.set(path.join(SCHEMA_DIR, root.file), renderSchema(root));
  return outputs;
}

function relative(filePath) {
  return path.relative(REPO_ROOT, filePath).replaceAll(path.sep, '/');
}

function withoutCarriageReturns(content) {
  return content === null ? null : content.replaceAll('\r', '');
}

function main() {
  let differences = 0;
  for (const [filePath, content] of expectedOutputs()) {
    if (CHECK_ONLY) {
      const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
      if (withoutCarriageReturns(current) !== withoutCarriageReturns(content)) {
        console.error(`  ✗ 生成物が定義元と一致しません: ${relative(filePath)}`);
        differences++;
      } else {
        console.log(`  ✓ 一致: ${relative(filePath)}`);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  ✓ 生成: ${relative(filePath)}`);
  }

  if (CHECK_ONLY) {
    console.log(`\n${differences === 0 ? '生成物に差分はありません' : `不一致 ${differences} 件`}`);
    process.exit(differences === 0 ? 0 : 1);
  }
}

main();
