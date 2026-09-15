'use strict';
const path = require('path');
// Install after the existing authenticated dashboard middleware.
function install(dashboard) {
  const ui = path.join(__dirname, 'ui');
  const serve = name => (req,res,next) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.sendFile(path.join(ui,name),err => {if(err) next(err);});
  };
  dashboard.get('/',serve('index.html'));
  dashboard.get('/console-assets/prices.js',serve('prices.js'));
  dashboard.get('/console-assets/analytics.js',serve('analytics.js'));
  dashboard.get('/console-assets/analytics.css',serve('analytics.css'));
  dashboard.get('/console-assets/console.css',serve('console.css'));
  dashboard.get('/console-assets/console.js',serve('console.js'));
  dashboard.get('/console-assets/models.js',serve('models.js'));
}
module.exports = {install};
