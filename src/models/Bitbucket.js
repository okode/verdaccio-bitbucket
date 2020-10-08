const axios = require('axios');

const API_URL = 'https://api.bitbucket.org';
const API_VERSION = '2.0';

function Bitbucket(username, password, logger) {
  this.apiUrl = `${API_URL}/${API_VERSION}`;
  this.username = username;
  this.password = password;
  this.logger = logger;
}

Bitbucket.prototype.getUser = function getUser() {
  // currently not in use, maybe in the future it will be.
  const { username, password, apiUrl } = this;
  return axios({
    method: 'get',
    url: `${apiUrl}/user`,
    auth: { username, password },
  }).then(response => response.data);
};

Bitbucket.prototype.getTeams = function getTeams() {
  const { username, password, apiUrl } = this;

  this.logger.debug(`[bitbucket] getting teams for ${username}, url: ${`${apiUrl}/user/permissions/workspaces`}`);

  function callApi(url) {
    return axios({
      method: 'get',
      url,
      auth: { username, password },
    }).then((response) => {
      return response.data.values.map(team => ({ name: team.workspace.slug, permission: team.permission }));
    });
  }

  return callApi(`${apiUrl}/user/permissions/workspaces`);
};


Bitbucket.prototype.getPrivileges = function getPrivileges() {
  return this.getTeams().then(teams => {
    const result = {};
    teams.forEach(team => {
      Object.assign(result, { [team.name]: team.permission });
    })
    return { teams: result };
  });
};


module.exports = Bitbucket;
