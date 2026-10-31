'use strict';
const path = require('path');
const assets=Object.freeze(['console.css','console-panels.css','models.css','analytics.css',
  'proxies.js','console.js','shell.js','models.js','prices.js','analytics.js','admin.css','admin-tools.js',
  'theme-nai.css','theme-nai.js','security.js','build.js','build.css',
  // Generated artwork: every ui/nai-<name>.webp present at startup.
  ...require('fs').readdirSync(path.join(__dirname,'ui')).filter(n=>/^nai-[a-z0-9-]{1,40}\.webp$/.test(n)).sort()]);
// Served before login (login page artwork and favicon). Static images only.
const publicAssets=Object.freeze(['nai-hero.webp','nai-logo.webp','nai-favicon.png']);
// Install after the existing authenticated dashboard middleware.
function install(dashboard) {
  const ui = path.join(__dirname, 'ui');
  const serve = name => (req,res,next) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control',name==='index.html'?'no-store':'private, max-age=2592000, immutable');
    res.sendFile(path.join(ui,name),err => {if(err) next(err);});
  };
  dashboard.get('/',serve('index.html'));
  for(const name of assets)dashboard.get('/console-assets/'+name,serve(name));
}
function installPublic(app) {
  const ui = path.join(__dirname, 'ui');
  for(const name of publicAssets)app.get('/public-assets/'+name,(req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','public, max-age=2592000, immutable');
    res.sendFile(path.join(ui,name),err => {if(err) next(err);});
  });
  app.get('/favicon.ico',(req,res)=>res.redirect(301,'/public-assets/nai-favicon.png'));
}
module.exports = {install,installPublic,assets,publicAssets};
