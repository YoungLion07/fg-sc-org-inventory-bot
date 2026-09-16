'use strict';

/**
 * An error whose message is safe and meant to be shown to the Discord user
 * (e.g. "You can't remove more than you have"). Anything else is treated as a
 * bug: logged in full, and the user just sees a generic "something went wrong".
 */
class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

module.exports = { UserError };
