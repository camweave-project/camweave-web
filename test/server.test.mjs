import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp, cameraURL, blockedAddress} from '../server.mjs';

test('viewing links and metadata destinations are constrained',()=>{
  const hosts=new Set(['camera.example']);
  assert.equal(cameraURL('http://camera.example:8080/watch/abcde',hosts),'http://camera.example:8080/watch/abcde/');
  for(const input of ['file:///watch/abcde','http://other/watch/abcde','http://camera.example/watch/abcd/','http://user:pass@camera.example/watch/abcde','http://camera.example/watch/abcde/?token=secret','http://camera.example/watch/abcde/stream'])assert.throws(()=>cameraURL(input,hosts));
  for(const ip of ['169.254.169.254','100.100.100.200','0.0.0.0','::','fe80::1','::ffff:169.254.169.254','224.0.0.1'])assert.equal(blockedAddress(ip),true);
  for(const ip of ['192.168.1.5','100.125.221.95','fd7a:115c:a1e0::1'])assert.equal(blockedAddress(ip),false);
});
test('authenticated camera lifecycle, controls, streams and boundaries',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'camweave-web-'));
  let quality=720,fps=10,iso=80,automatic=true,redirect=false,requests=0;
  const fixture=http.createServer((req,res)=>{
    requests++;const u=new URL(req.url,'http://fixture');
    if(redirect){res.writeHead(302,{Location:'http://169.254.169.254/'});return res.end();}
    if(u.pathname.endsWith('/stream')){res.writeHead(200,{'Content-Type':'multipart/x-mixed-replace; boundary=frame'});return res.end('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\xff\xd8\xff\xd9\r\n');}
    if(req.method==='POST'){
      assert.equal(req.headers['x-camera-control'],'1');
      if(u.pathname.endsWith('/settings')){quality=Number(u.searchParams.get('quality'));fps=Number(u.searchParams.get('fps'));}
      else {automatic=u.searchParams.get('mode')==='auto';iso=automatic?80:Number(u.searchParams.get('iso'));}
      res.writeHead(202);return res.end();
    }
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({quality,fps,privateField:'never-forward',exposure:{iso,selectedISO:iso,minimum:33,maximum:4125,automatic,supported:true,seconds:1/120}}));
  });
  await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:18087', password='test-password-not-for-production';
  const options={publicURL:base,password,cameraHosts:['127.0.0.1'],dataDir:directory};
  const app=await createApp(options);await new Promise(r=>app.listen(18087,'127.0.0.1',r));
  t.after(async()=>{app.closeAllConnections();fixture.closeAllConnections();await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>fixture.close(r))]);await rm(directory,{recursive:true,force:true});});
  let cookie;
  async function call(path,method='GET',data,extra={}) {return fetch(base+path,{method,headers:{Origin:base,'Content-Type':'application/json','X-Camweave-Control':'1',...(cookie?{Cookie:cookie}:{}),...extra},body:data===undefined?undefined:JSON.stringify(data)});}
  assert.equal((await call('/api/cameras')).status,401);
  assert.equal((await call('/api/login','POST',{password},{Origin:'https://evil.test'})).status,403);
  assert.equal((await call('/api/login','POST',{password:'wrong'})).status,401);
  let response=await call('/api/login','POST',{password});assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);cookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/cameras','POST',{name:'Bad',url:'http://169.254.169.254/watch/abcde/'})).status,400);
  const url=`http://127.0.0.1:${fixture.address().port}/watch/test-only-code/`;
  response=await call('/api/cameras','POST',{name:'Garden',url});assert.equal(response.status,201);const {id}=await response.json();
  const list=await (await call('/api/cameras')).json();assert.equal(list.length,1);assert.equal(list[0].name,'Garden');assert.ok(!JSON.stringify(list).includes('test-only-code'));
  assert.equal((await call('/api/cameras','POST',{name:'Duplicate',url})).status,409);
  assert.equal(JSON.parse(await readFile(join(directory,'cameras.json'),'utf8'))[0].url,url);assert.equal((await stat(join(directory,'cameras.json'))).mode&0o777,0o600);
  let status=await (await call(`/api/cameras/${id}/status`)).json();assert.equal(status.quality,720);assert.equal(status.privateField,undefined);
  assert.equal((await call(`/api/cameras/${id}/settings`,'POST',{quality:1080,fps:5})).status,202);
  assert.equal((await call(`/api/cameras/${id}/exposure`,'POST',{mode:'manual',iso:1200})).status,202);
  status=await (await call(`/api/cameras/${id}/status`)).json();assert.equal(status.quality,1080);assert.equal(status.fps,5);assert.equal(status.exposure.iso,1200);assert.equal(status.exposure.seconds,1/120);
  response=await call(`/api/cameras/${id}/stream`);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/multipart/);assert.match(await response.text(),/Content-Length: 4/);
  assert.equal((await call(`/api/cameras/${id}/settings`,'POST',{quality:999,fps:5})).status,400);
  assert.equal((await call(`/api/cameras/${id}/exposure`,'POST',{mode:'manual',iso:-1})).status,400);
  assert.equal((await call(`/api/cameras/${id}/exposure`,'POST',{mode:'auto'},{'X-Camweave-Control':''})).status,403);
  redirect=true;const before=requests;assert.equal((await call(`/api/cameras/${id}/status`)).status,502);assert.equal(requests,before+1);redirect=false;
  const wrongHost=await new Promise((resolve,reject)=>{const req=http.get(base+'/api/cameras',{headers:{Host:'evil.test',Cookie:cookie}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(wrongHost,403);
  assert.equal((await call(`/api/cameras/${id}`,'DELETE')).status,200);assert.equal((await (await call('/api/cameras')).json()).length,0);
  assert.equal((await call('/api/logout','POST',{})).status,200);assert.equal((await call('/api/cameras')).status,401);
});
