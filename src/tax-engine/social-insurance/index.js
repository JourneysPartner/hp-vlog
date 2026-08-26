'use strict';

const standardRemuneration = require('./standard-remuneration.js');
const monthlyPremium = require('./monthly-premium.js');
const bonusPremium = require('./bonus-premium.js');

module.exports = {
  determineStandardRemuneration: standardRemuneration.determineStandardRemuneration,
  calculateMonthlyPremium: monthlyPremium.calculateMonthlyPremium,
  calculateBonusPremium: bonusPremium.calculateBonusPremium,
};
