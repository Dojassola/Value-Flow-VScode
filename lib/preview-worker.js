'use strict';
const {workerData,parentPort}=require('node:worker_threads');
const {buildPreview}=require('./react-preview');
try{parentPort.postMessage({ok:true,result:buildPreview(workerData)});}catch(error){parentPort.postMessage({ok:false,error:error.message});}
