const Bitbucket = require('../models/Bitbucket');

let username = '';
let password = '';

let bb = new Bitbucket(username, password, { debug: () => {} });

bb.getPrivileges().then(res => console.log(res));