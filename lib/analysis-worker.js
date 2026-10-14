'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { parseTS } = require('./ts-analysis');
try { parentPort.postMessage({ok:true,result:parseTS(workerData.text,workerData.file,workerData.offset)}); }
catch(error){parentPort.postMessage({ok:false,error:error.message});}
