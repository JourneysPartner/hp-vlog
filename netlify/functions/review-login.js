'use strict';

const { login } = require('./lib/review-auth');
exports.handler = event => login(event);
