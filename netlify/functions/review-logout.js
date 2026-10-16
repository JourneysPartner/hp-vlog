'use strict';

const { logout } = require('./lib/review-auth');
exports.handler = event => logout(event);
