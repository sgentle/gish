#!/usr/bin/env node

require('coffee-script/register')
require('./gish')(process.argv[2])
.then(function(hash) {
  return console.log(hash.toString('hex'));
})
.catch(function(err) {
  return console.error(err.stack || err);
});
