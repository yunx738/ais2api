'use strict';
const path = require('path');
const assets=Object.freeze(['console.css','console-panels.css','models.css','analytics.css',
  'proxies.js','console.js','shell.js','models.js','prices.js','analytics.js']);
// Install after the existing authenticated dashboard middleware.
function install(dashboard) {
  const ui = path.join(__dirname, 'ui');
  const serve = name => (req,res,next) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.sendFile(path.join(ui,name),err => {if(err) next(err);});
  };
  dashboard.get('/',serve('index.html'));
  for(const name of assets)dashboard.get('/console-assets/'+name,serve(name));
}
module.exports = {install,assets};
