'use strict';

/**
 * definitions.jsを直接解釈するWire入力検証器。
 * 生成済みJSON Schemaは参照せず、成功時のbigint変換もこの境界で完了させる。
 */

const { definitions } = require('../../../scripts/lib/input-types/definitions.js');
const {
  moneyFromWire,
  exactFromWire,
  rateFromWire,
  areaFromWire,
} = require('../../../scripts/lib/input-types/wire-converters.js');

const ROOT_NAMES = Object.freeze({
  hojinnari: 'HojinnariInput',
  shohizei: 'ShohizeiInput',
  sozoku: 'SozokuInput',
  yakuin_hoshu: 'YakuinHoshuInput',
});
const WIRE_CONVERTERS = Object.freeze({
  Money: moneyFromWire,
  Exact: exactFromWire,
  Rate: rateFromWire,
  Area: areaFromWire,
});

function addError(errors, code, fieldPath, message) {
  errors.push({ code, fieldPath, message });
}

function childPath(parent, property) {
  return parent === '$' ? `$.${property}` : `${parent}.${property}`;
}

function indexPath(parent, index) {
  return `${parent}[${index}]`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isLocalDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1];
}

function resolveReference(name, substitutions) {
  if (substitutions.has(name)) return substitutions.get(name);
  const definition = definitions[name];
  if (!definition) throw new Error(`入力型の参照先がありません: ${name}`);
  return definition;
}

function mergeShape(target, source) {
  Object.assign(target.properties, source.properties);
  for (const name of source.required) target.required.add(name);
}

function objectShape(node, substitutions = new Map(), seen = new Set()) {
  if (node.kind === 'ref') {
    if (substitutions.has(node.name)) {
      return objectShape(substitutions.get(node.name), substitutions, seen);
    }
    if (seen.has(node.name)) throw new Error(`入力型の継承が循環しています: ${node.name}`);
    const nextSeen = new Set(seen);
    nextSeen.add(node.name);
    return objectShape(resolveReference(node.name, substitutions), substitutions, nextSeen);
  }
  if (node.kind === 'intersection') {
    const shape = { properties: {}, required: new Set() };
    for (const part of node.parts) mergeShape(shape, objectShape(part, substitutions, seen));
    return shape;
  }
  if (node.kind !== 'object') return null;

  const shape = { properties: {}, required: new Set() };
  for (const base of node.bases || []) {
    mergeShape(shape, objectShape({ kind: 'ref', name: base }, substitutions, seen));
  }
  for (const [name, property] of Object.entries(node.required)) {
    shape.properties[name] = property;
    shape.required.add(name);
  }
  Object.assign(shape.properties, node.optional);
  return shape;
}

function literalProperties(node, substitutions) {
  const shape = objectShape(node, substitutions);
  if (shape === null) return new Map();
  const literals = new Map();
  for (const [name, property] of Object.entries(shape.properties)) {
    let resolved = property;
    if (property.kind === 'ref') resolved = resolveReference(property.name, substitutions);
    if (resolved.kind === 'literal') literals.set(name, resolved.value);
  }
  return literals;
}

function unionDiscriminator(variants, substitutions) {
  const candidates = variants.map(variant => literalProperties(variant, substitutions));
  if (candidates.some(candidate => candidate.size === 0)) return null;
  for (const preferred of ['kind', 'mode', 'include']) {
    if (candidates.every(candidate => candidate.has(preferred))) {
      return { name: preferred, candidates };
    }
  }
  for (const name of candidates[0].keys()) {
    if (candidates.every(candidate => candidate.has(name))) return { name, candidates };
  }
  return null;
}

function validateClosedObject(node, value, path, errors, substitutions) {
  if (!isPlainObject(value)) {
    addError(errors, 'invalid_type', path, 'オブジェクトで指定してください');
    return undefined;
  }
  const shape = objectShape(node, substitutions);
  const allowed = new Set(Object.keys(shape.properties));
  for (const name of Object.keys(value)) {
    if (!allowed.has(name)) {
      addError(errors, 'unknown_property', childPath(path, name), '定義されていないプロパティです');
    }
  }
  for (const name of shape.required) {
    if (!Object.hasOwn(value, name)) {
      addError(errors, 'missing_property', childPath(path, name), '必須プロパティがありません');
    }
  }

  const converted = {};
  for (const [name, property] of Object.entries(shape.properties)) {
    if (!Object.hasOwn(value, name)) continue;
    const convertedProperty = validateNode(
      property,
      value[name],
      childPath(path, name),
      errors,
      substitutions
    );
    if (convertedProperty !== undefined) converted[name] = convertedProperty;
  }
  return converted;
}

function isPeriodSegmentNode(node) {
  return node.kind === 'genericRef' && node.name === 'PeriodSegment';
}

function validatePeriodSegments(segments, path, errors) {
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1] && segments[index - 1].period;
    const current = segments[index] && segments[index].period;
    if (!previous || !current || typeof previous.from !== 'string' || typeof previous.to !== 'string' ||
        typeof current.from !== 'string' || typeof current.to !== 'string') continue;
    if (current.from < previous.from) {
      addError(
        errors,
        'period_segment_order',
        `${indexPath(path, index)}.period`,
        '期間セグメントは開始日の昇順で指定してください'
      );
    }
    if (current.from <= previous.to) {
      addError(
        errors,
        'period_segment_overlap',
        `${indexPath(path, index)}.period`,
        '期間セグメントが直前の期間と重なっています'
      );
    }
  }
}

function validateNamedReference(name, value, path, errors, substitutions) {
  if (substitutions.has(name)) {
    return validateNode(substitutions.get(name), value, path, errors, substitutions);
  }
  const before = errors.length;
  const converted = validateNode(definitions[name], value, path, errors, substitutions);
  if (errors.length !== before || converted === undefined) return converted;

  if (name === 'LocalDate' && !isLocalDate(value)) {
    addError(errors, 'invalid_local_date', path, '実在する日付をYYYY-MM-DD形式で指定してください');
    return undefined;
  }
  if (name === 'DateRange' && converted.from > converted.to) {
    addError(errors, 'invalid_date_range', path, '期間のfromはto以前を指定してください');
    return undefined;
  }
  if (name === 'LifeInsurancePremiumInput' &&
      converted.generation === 'old' && converted.category === 'nursing_medical') {
    addError(
      errors,
      'invalid_insurance_category',
      childPath(path, 'category'),
      '旧契約に介護医療保険料区分は指定できません'
    );
    return undefined;
  }
  if (Object.hasOwn(WIRE_CONVERTERS, name)) {
    try {
      return WIRE_CONVERTERS[name](value);
    } catch (error) {
      addError(errors, 'invalid_wire_value', path, error.message);
      return undefined;
    }
  }
  return converted;
}

function validateUnion(node, value, path, errors, substitutions) {
  const discriminator = isPlainObject(value)
    ? unionDiscriminator(node.variants, substitutions)
    : null;
  if (discriminator !== null) {
    const actual = value[discriminator.name];
    const index = discriminator.candidates.findIndex(candidate =>
      Object.is(candidate.get(discriminator.name), actual));
    if (index === -1) {
      addError(
        errors,
        'invalid_discriminator',
        childPath(path, discriminator.name),
        `${discriminator.name}が判別可能ユニオンの値集合外です`
      );
      return undefined;
    }
    return validateNode(node.variants[index], value, path, errors, substitutions);
  }

  const attempts = node.variants.map(variant => {
    const variantErrors = [];
    const converted = validateNode(variant, value, path, variantErrors, substitutions);
    return { converted, errors: variantErrors };
  });
  const success = attempts.find(attempt => attempt.errors.length === 0);
  if (success) return success.converted;
  const nearest = attempts.reduce((best, attempt) =>
    best === null || attempt.errors.length < best.errors.length ? attempt : best, null);
  addError(errors, 'invalid_union', path, 'いずれの入力形式にも一致しません');
  errors.push(...nearest.errors);
  return undefined;
}

function validateNode(node, value, path, errors, substitutions = new Map()) {
  switch (node.kind) {
    case 'string':
      if (typeof value !== 'string') {
        addError(errors, 'invalid_type', path, '文字列で指定してください');
        return undefined;
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') {
        addError(errors, 'invalid_type', path, '真偽値で指定してください');
        return undefined;
      }
      return value;
    case 'integer':
      if (!Number.isSafeInteger(value)) {
        addError(errors, 'invalid_integer', path, '安全に扱える整数で指定してください');
        return undefined;
      }
      return value;
    case 'bigint': {
      const pattern = node.positive ? /^[1-9][0-9]*$/ : /^-?[0-9]+$/;
      if (typeof value !== 'string' || !pattern.test(value)) {
        addError(errors, 'invalid_decimal_integer', path, '指数表記等を含まない整数文字列で指定してください');
        return undefined;
      }
      return BigInt(value);
    }
    case 'brandedString':
      if (typeof value !== 'string' || !(new RegExp(node.pattern)).test(value)) {
        addError(errors, 'invalid_format', path, node.description || '文字列の形式が不正です');
        return undefined;
      }
      return value;
    case 'literal':
      if (!Object.is(value, node.value)) {
        addError(errors, 'invalid_literal', path, `${JSON.stringify(node.value)}を指定してください`);
        return undefined;
      }
      return value;
    case 'enum':
      if (!node.values.some(candidate => Object.is(candidate, value))) {
        addError(errors, 'invalid_enum', path, '値が列挙の範囲外です');
        return undefined;
      }
      return value;
    case 'ref':
      return validateNamedReference(node.name, value, path, errors, substitutions);
    case 'array': {
      if (!Array.isArray(value)) {
        addError(errors, 'invalid_type', path, '配列で指定してください');
        return undefined;
      }
      const converted = value.map((item, index) =>
        validateNode(node.items, item, indexPath(path, index), errors, substitutions));
      if (isPeriodSegmentNode(node.items)) validatePeriodSegments(converted, path, errors);
      return converted;
    }
    case 'record': {
      if (!isPlainObject(value)) {
        addError(errors, 'invalid_type', path, 'オブジェクトで指定してください');
        return undefined;
      }
      const converted = {};
      for (const [name, propertyValue] of Object.entries(value)) {
        const convertedProperty = validateNode(
          node.values,
          propertyValue,
          childPath(path, name),
          errors,
          substitutions
        );
        if (convertedProperty !== undefined) converted[name] = convertedProperty;
      }
      return converted;
    }
    case 'genericRef': {
      const generic = definitions[node.name];
      if (!generic || !generic.parameters || generic.parameters.length !== node.arguments.length) {
        throw new Error(`入力型の型引数が一致しません: ${node.name}`);
      }
      const next = new Map(substitutions);
      generic.parameters.forEach((parameter, index) => next.set(parameter, node.arguments[index]));
      return validateNode(generic, value, path, errors, next);
    }
    case 'union':
      return validateUnion(node, value, path, errors, substitutions);
    case 'intersection':
    case 'object':
      return validateClosedObject(node, value, path, errors, substitutions);
    default:
      throw new Error(`解釈できない入力型定義です: ${node.kind}`);
  }
}

function validateInput(simulatorType, wireInput) {
  const rootName = ROOT_NAMES[simulatorType];
  if (!rootName) {
    return {
      ok: false,
      errors: [{
        code: 'unknown_simulator_type',
        fieldPath: '$',
        message: '対応していないシミュレーター種別です',
      }],
      normalizationSuggestions: [],
    };
  }

  const errors = [];
  const value = validateNamedReference(rootName, wireInput, '$', errors, new Map());
  if (errors.length > 0) return { ok: false, errors, normalizationSuggestions: [] };
  return { ok: true, value, normalizationSuggestions: [] };
}

module.exports = Object.freeze({ validateInput });
