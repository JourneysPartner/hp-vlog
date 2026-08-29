'use strict';

/**
 * 端数規則マスターに従い、ExactをMoneyへ確定する唯一の入口。
 * 引数はExactだけなので、確定済みMoneyを再度丸める二重丸めはできない。
 */

const { exact } = require('./money.js');
const dataSource = require('../masters/data-source.js');

const ruleDocument = JSON.parse(dataSource.getRoundingRulesContent());
const rulesById = new Map();
for (const rule of ruleDocument.rules) {
  if (rulesById.has(rule.rounding_rule_id)) {
    throw new Error(`端数規則IDが重複しています: ${rule.rounding_rule_id}`);
  }
  rulesById.set(rule.rounding_rule_id, Object.freeze({ ...rule }));
}

function requireUnit(rule) {
  if (!Number.isSafeInteger(rule.unit) || rule.unit <= 0) {
    throw new Error(`端数規則${rule.rounding_rule_id}のunitが正の安全な整数ではありません`);
  }
  return BigInt(rule.unit);
}

function truncateTowardZero(value, unit) {
  // 税務実務上の「切捨て」は負数（還付等）でも絶対値を小さくする0方向とする。
  // bigintの整数除算は0方向へ丸めるため、単位込みの除数で一度だけ除算する。
  return (value.num / (value.den * unit)) * unit;
}

function roundHalfUp(value, unit) {
  const divisor = value.den * unit;
  const magnitude = value.num < 0n ? -value.num : value.num;
  let quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  if (remainder * 2n >= divisor) quotient += 1n;
  return (value.num < 0n ? -quotient : quotient) * unit;
}

function roundHalfDown(value, unit) {
  // 絶対値で判定してから符号を戻す。ちょうど2分の1は切り捨てる。
  const divisor = value.den * unit;
  const magnitude = value.num < 0n ? -value.num : value.num;
  let quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  if (remainder * 2n > divisor) quotient += 1n;
  return (value.num < 0n ? -quotient : quotient) * unit;
}

function applyRounding(value, roundingRuleId) {
  const checked = exact(value);
  if (roundingRuleId === null || roundingRuleId === undefined) {
    throw new TypeError('rounding_rule_idは未決定のまま計算へ渡せません');
  }
  if (typeof roundingRuleId !== 'string' || roundingRuleId.length === 0) {
    throw new TypeError('rounding_rule_idは空でない文字列で指定してください');
  }

  const rule = rulesById.get(roundingRuleId);
  if (!rule) throw new RangeError(`未知のrounding_rule_idです: ${roundingRuleId}`);

  if (rule.direction === 'none') {
    if (rule.unit !== null) {
      throw new Error(`端数規則${roundingRuleId}のnoneにはunitを指定できません`);
    }
    if (checked.num % checked.den !== 0n) {
      throw new RangeError(`${roundingRuleId}へ整数でないExactを渡すことはできません`);
    }
    return { unit: 'JPY', value: checked.num / checked.den };
  }

  if (rule.direction === 'insurer_specific') {
    throw new Error(`${roundingRuleId}の適用には保険者別の規則が必要です`);
  }

  const unit = requireUnit(rule);
  if (rule.direction === 'truncate') {
    return { unit: 'JPY', value: truncateTowardZero(checked, unit) };
  }
  if (rule.direction === 'half_up') {
    return { unit: 'JPY', value: roundHalfUp(checked, unit) };
  }
  if (rule.direction === 'half_down') {
    return { unit: 'JPY', value: roundHalfDown(checked, unit) };
  }
  throw new Error(`端数規則${roundingRuleId}のdirectionが未対応です: ${rule.direction}`);
}

module.exports = { applyRounding };
