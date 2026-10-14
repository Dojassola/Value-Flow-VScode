'use strict';
const sensitive=/password|passwd|token|secret|authorization|cookie|session|credential|api.?key|access.?key|cpf|email/i;
function text(s){return String(s).slice(0,1600).replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[JWT]').replace(/((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,'$1[REDACTED]');}
function redact(v,depth=0,key=''){if(sensitive.test(key))return '[REDACTED]';if(v==null||typeof v==='boolean'||typeof v==='number')return v;if(typeof v==='string')return text(v);if(typeof v!=='object')return '[non-data]';if(depth>=6)return '[depth limit]';const result=Array.isArray(v)?[]:{};for(const k of Object.keys(v).slice(0,60)){if(['__proto__','constructor','prototype'].includes(k))continue;result[k]=redact(v[k],depth+1,k);}return result;}
function safeUrl(s){try{const u=new URL(s);return ['http:','https:'].includes(u.protocol)?u.origin+u.pathname:'['+u.protocol+']';}catch{return '[invalid URL]';}}
function origin(s){const u=new URL(s);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Only http(s) origins without embedded credentials are supported.');return u.origin;}
function local(s){const u=new URL(s);return['localhost','127.0.0.1','[::1]'].includes(u.hostname);}
module.exports={redact,text,safeUrl,origin,local};
