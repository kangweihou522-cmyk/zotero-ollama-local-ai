/* SPDX-License-Identifier: MIT
 * Synthetic loopback-only Ollama protocol fixture. No real model is loaded.
 */
const http = require('node:http');

const overview = {
  background: 'A synthetic native-host test checks a local literature workflow.',
  question: 'Can the installed addon save locally generated results?',
  methods: 'The isolated host calls a loopback protocol fixture and writes temporary library items.',
  findings: 'The fixture provides test content only, without research findings.',
  limitations: 'This is protocol and storage validation, not a real-model quality evaluation.',
  relevance: 'The test checks installation, bootstrap, native HTTP and database integration.'
};

const server = http.createServer(async (request, response) => {
  const send = (status, value) => {
    response.writeHead(status, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(value));
  };
  try {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) return send(413, {error: 'fixture request too large'});
    }
    const payload = body ? JSON.parse(body) : {};
    console.log(request.method + ' ' + request.url);
    if (request.method === 'GET' && request.url === '/health') return send(200, {ok: true});
    if (request.method === 'GET' && request.url === '/api/tags') {
      return send(200, {models: [{name: 'smoke-model', size: 1, details: {family: 'smoke'}}]});
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      return send(200, {models: [{name:'smoke-model',size:3000000000,size_vram:3000000000,context_length:8192}]});
    }
    if (request.method === 'POST' && request.url === '/api/show' && payload.model === 'smoke-model') {
      return send(200, {capabilities: ['completion'], details: {family: 'smoke'}, model_info: {'smoke.context_length': 8192}});
    }
    if (request.method === 'POST' && request.url === '/api/chat' && payload.model === 'smoke-model') {
      if(payload.stream) {
        const text=JSON.stringify({tags:['native smoke'],note:'Local native test fixture.',overview});
        response.writeHead(200,{'Content-Type':'application/x-ndjson'});
        for(let index=0;index<text.length;index+=200) {
          response.write(JSON.stringify({model:'smoke-model',done:false,message:{content:text.slice(index,index+200)}})+'\n');
          await new Promise(resolve=>setTimeout(resolve,120));
        }
        response.end(JSON.stringify({model:'smoke-model',done:true,done_reason:'stop',message:{content:''},eval_count:100,eval_duration:2000000000,load_duration:100000000,prompt_eval_count:50})+'\n');
        return;
      }
      return send(200, {
        model: 'smoke-model', done: true, done_reason: 'stop',
        message: {role: 'assistant', content: JSON.stringify({tags: ['native smoke'], note: 'Local native test fixture.', overview})}
      });
    }
    return send(404, {error: 'unknown fixture endpoint or model'});
  } catch (error) { return send(400, {error: error.message}); }
});
server.listen(11435, '127.0.0.1', () => console.log('Loopback Ollama fixture listening on 127.0.0.1:11435'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
