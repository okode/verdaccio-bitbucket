const NodeCache = require('node-cache');
const Bitbucket = require('./models/Bitbucket');
const getRedisClient = require('./redis');
const { CACHE_REDIS, CACHE_IN_MEMORY } = require('./constants');
const minimatch = require('minimatch');

const ALLOWED_CACHE_ENGINES = [CACHE_IN_MEMORY, CACHE_REDIS];

/**
 * Default cache time-to-live in seconds
 * It could be changed via config ttl option,
 * which should be also defined in seconds
 *
 * @type {number}
 * @access private
 */
const DEFAULT_CACHE_TTL = 24 * 60 * 60 * 7;

/**
 * Parses config allow option and returns result
 *
 * @param {string} allow - string to parse
 * @returns {Object}
 * @access private
 */
function parseAllow(allow) {
  const result = {};

  allow.split(/\s*,\s*/).forEach((team) => {
    const newTeam = team.trim().match(/^(.*?)(\((.*?)\))?$/);

    result[newTeam[1]] = newTeam[3] ? newTeam[3].split('|') : [];
  });

  return result;
}

/**
 * @class Auth
 * @classdesc Auth class implementing an Auth interface for Verdaccio
 * @param {Object} config
 * @param {Object} stuff
 * @returns {Auth}
 * @constructor
 * @access public
 */
function Auth(config, stuff) {
  if (!(this instanceof Auth)) {
    return new Auth(config, stuff);
  }

  const cacheEngine = config.cache || false;
  if (config.cache && !ALLOWED_CACHE_ENGINES.includes(cacheEngine)) {
    throw Error(`Invalid cache engine ${cacheEngine}, please use on of these: [${ALLOWED_CACHE_ENGINES.join(', ')}]`);
  }

  this.cacheEngine = cacheEngine;

  switch (this.cacheEngine) {
    case CACHE_REDIS:
      if (!config.redis) {
        throw Error('Can\'t find Redis configuration');
      }
      this.cache = getRedisClient(config.redis);
      break;
    case CACHE_IN_MEMORY:
      this.cache = new NodeCache();
      break;
    default:
      this.cache = false;
  }

  this.bcrypt = config.hashPassword !== false ? require('bcrypt') : { // eslint-disable-line
    compareSync: (a, b) => (a === b),
    hashSync: password => password,
  };

  this.allow = parseAllow(config.allow);
  this.defaultMailDomain = config.defaultMailDomain;
  this.ttl = (config.ttl || DEFAULT_CACHE_TTL) * 1000;
  this.logger = stuff.logger;
}

Auth.prototype.allow_access = async function allow_access(user, pkg, callback) {

  let allowAccess = parseAllow(pkg.access.join(','));

  let cachedUser;

  try {
    let cached = await this.cache.get(user.name);
    if (cached) {
      cachedUser = JSON.parse(cached);
    }
  } catch (err) {
    this.logger.warn('Cant get from cache, must authenticate', err);
    return callback(err);
  }

  let canAccess = Object.keys(cachedUser.privileges.teams).some(team => {

    if (allowAccess[team] == null) {
      return false;
    }

    if (!allowAccess[team].length) {
      return true;
    }

    return allowAccess[team].includes(cachedUser.privileges.teams[team]);
  });

  if (canAccess) {
    return callback(null, true);
  } else {
    return callback(null, false);
  }
}

Auth.prototype.allow_publish = async function allow_publish(user, pkg, callback) {
  console.log(JSON.stringify(pkg));

  let allowPublish = parseAllow(pkg.publish.join(','));

  let cachedUser;

  try {
    let cached = await this.cache.get(user.name);
    if (cached) {
      cachedUser = JSON.parse(cached);
      console.log(JSON.stringify(cachedUser));
    }
  } catch (err) {
    this.logger.warn('Cant get from cache, must authenticate', err);
    return callback(err);
  }

  let canPublish = Object.keys(cachedUser.privileges.teams).some(team => {

    if (allowPublish[team] == null) {
      return false;
    }

    if (!allowPublish[team].length) {
      return true;
    }

    return allowPublish[team].includes(cachedUser.privileges.teams[team]);
  });

  if (canPublish) {
    return callback(null, true);
  } else {
    return callback(null, false);
  }
}

/**
 * Decodes a username to an email address.
 *
 * Since the local portion of email addresses
 * can't end with a dot or contain two consecutive
 * dots, we can replace the `@` with `..`. This
 * function converts from the above encoding to
 * a proper email address.
 *
 * @param {string} username
 * @returns {string}
 * @access private
 */
Auth.prototype.decodeUsernameToEmail = function decodeUsernameToEmail(username) {
  const pos = username.lastIndexOf('..');
  if (pos === -1) {
    if (this.defaultMailDomain) {
      return `${username}@${this.defaultMailDomain}`;
    }

    return username;
  }

  return `${username.substr(0, pos)}@${username.substr(pos + 2)}`;
};

/**
 * Logs a given error
 * This is private method running in context of Auth object
 *
 * @param {object} logger
 * @param {string} err
 * @param {string} username
 * @access private
 */
const logError = (logger, err, username) => {
  logger.warn(`${err.code}, user: ${username}, Bitbucket API adaptor error: ${err.message}`);
};

/**
 * Performs user authentication by a given credentials
 * On success or failure executing done(err, teams) callback
 *
 * @param {string} username - user name on bitbucket
 * @param {string} password - user password on bitbucket
 * @param {Function} done - success or error callback
 * @access public
 */
Auth.prototype.authenticate = async function authenticate(username, password, done) {
  if (this.cache) {
    try {
      let cached = await this.cache.get(username);
      if (cached) {
        cached = JSON.parse(cached);
      }
      if (cached && this.bcrypt.compareSync(password, cached.password)) {
        return done(null, cached.teams);
      }
    } catch (err) {
      this.logger.warn('Cant get from cache', err);
    }
  }
  const bitbucket = new Bitbucket(
    this.decodeUsernameToEmail(username),
    password,
    this.logger,
  );

  return bitbucket.getPrivileges().then(async (privileges) => {
    const teams = Object.keys(privileges.teams)
      .filter((team) => {
        if (this.allow[team] === undefined) {
          return false;
        }

        if (!this.allow[team].length) {
          return true;
        }

        return this.allow[team].includes(privileges.teams[team]);
      }, this);

    if (this.cache) {
      const hashedPassword = this.bcrypt.hashSync(password, 10);
      try {
        if (this.cacheEngine === CACHE_IN_MEMORY) {
          await this.cache.set(username, JSON.stringify({ teams, privileges, password: hashedPassword }), this.ttl, () => { });
        } else if (this.cacheEngine === CACHE_REDIS) {
          await this.cache.set(username, JSON.stringify({ teams, privileges, password: hashedPassword }), 'EX', this.ttl);
        }
      } catch (err) {
        this.logger.warn('Cant save to cache', err);
      }
    }

    return done(null, teams);
  }).catch((err) => {
    logError(this.logger, err, username);
    return done(err, false);
  });
};

module.exports = Auth;
