'use strict';

const standardRemuneration = require('./standard-remuneration.js');
const monthlyPremium = require('./monthly-premium.js');
const bonusPremium = require('./bonus-premium.js');
const nhiPremium = require('./nhi-premium.js');
const nationalPension = require('./national-pension.js');

module.exports = {
  determineStandardRemuneration: standardRemuneration.determineStandardRemuneration,
  calculateMonthlyPremium: monthlyPremium.calculateMonthlyPremium,
  calculateBonusPremium: bonusPremium.calculateBonusPremium,
  calculateNhiPremium: nhiPremium.calculateNhiPremium,
  calculateNationalPension: nationalPension.calculateNationalPension,
};
