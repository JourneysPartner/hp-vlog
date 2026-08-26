'use strict';

const engine = require('./consumption-tax.js');

module.exports = Object.freeze({
  consumptionTax: engine,
  calculate: engine.calculate,
  compareMethods: engine.compareMethods,
  calculateTwoWariFromSalesTax: engine.calculateTwoWariFromSalesTax,
});
