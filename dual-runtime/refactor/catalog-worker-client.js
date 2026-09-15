 'use strict';
const http = require('http');
const ID = /^[a-f0-9-]{36}$/;
function createCatalogWorkerClient(workers) {
  return function call(slot, account, jobId) {
    if (!['A','B'].includes(slot) || !Number.isSafeInteger(account) || account < 1) {
      return Promise.reject(Error('Invalid catalog destination'));
    }
    const control = workers[slot]?.control;
    if (typeof control !== 'string' || control.length < 32 ||
        (jobId !== undefined && !ID.test(jobId))) {
      return Promise.reject(Error('Invalid catalog credentials or job identity'));
    }
    return new Promise((resolve,reject) => {
      let finished = false, timer;
      const finish = (error,value) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const headers = {'X-Worker-Key':control};
      if (jobId !== undefined) {
        headers['X-Catalog-Job'] = jobId;
        headers['X-Catalog-Account'] = String(account);
        headers['Content-Length'] = '0';
      }
      const req = http.request({
        hostname:'127.0.0.1',port:slot === 'A' ? 8891 : 8892,
        path:jobId === undefined ? '/internal/models' : '/internal/models/refresh',
        method:jobId === undefined ? 'GET' : 'POST',headers,agent:false
      },res => {
        let bytes = 0; const chunks = [];
        res.on('data',chunk => {
          bytes += chunk.length;
          if (bytes > 4194304) {
            finish(Error('Catalog control response too large'));
            res.destroy(); req.destroy(); return;
          }
          chunks.push(chunk);
        });
        res.on('aborted',() => finish(Error('Catalog control response aborted')));
        res.on('error',() => finish(Error('Catalog control response failed')));
        res.on('end',() => {
          try {
            if (![200,202,409].includes(res.statusCode)) throw Error();
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!data || data.account !== account) throw Error();
            if (jobId === undefined) {
              if (typeof data.syncing !== 'boolean') throw Error();
            } else if (data.jobId !== jobId || typeof data.accepted !== 'boolean') {
              throw Error();
            }
            finish(undefined,data);
          } catch { finish(Error('Catalog control response rejected')); }
        });
      });
      req.on('error',() => finish(Error('Catalog control connection failed')));
      timer = setTimeout(() => {
        finish(Error('Catalog control deadline exceeded')); req.destroy();
      },5000);
      req.end();
    });
  };
}
module.exports = {createCatalogWorkerClient};
