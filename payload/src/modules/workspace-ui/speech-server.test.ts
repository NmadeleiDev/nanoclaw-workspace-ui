import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {SpeechTranscriber,parseSpeech,speechStatus} from './speech.js';
import {DEFAULT_SPEECH} from './types.js';
import {initTestDb,closeDb} from '../../db/connection.js';
import {runMigrations} from '../../db/migrations/index.js';
import {workspaceSpeechBackendsMigration} from './migration.js';
import {WorkspaceStore} from './store.js';
let server: http.Server | undefined;
const root=path.resolve('.cache/speech-http-test');
afterEach(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;await closeDb();});
async function listen(handler: http.RequestListener) {
 server=http.createServer(handler);await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
 return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
}
it('uses the documented whisper.cpp health and multipart inference contract without invoking a CLI or writing audio',async()=>{
 const wav=Buffer.concat([Buffer.from('524946462419000057415645666d74201000000001000100803e0000007d0000020010006461746100190000','hex'),Buffer.alloc(6400,0x40)]);
 let received: unknown;
 const endpoint=await listen(async(req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"status":"ok"}');return;}
  try {
   expect(req.url).toBe('/inference');expect(req.method).toBe('POST');
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const request=new Request('http://localhost/inference',{method:'POST',headers:{'Content-Type':req.headers['content-type']!},body:Buffer.concat(chunks)});
   const form=await request.formData();const file=form.get('file') as File;
   received={format:form.get('response_format'),language:form.get('language'),file:Buffer.from(await file.arrayBuffer()),type:file.type};
   res.writeHead(200,{'Content-Type':'application/json'});res.end('{"text":" Local server transcript. "}');
  }catch(error){res.writeHead(500);res.end();throw error;}
 });
 const settings={...DEFAULT_SPEECH,enabled:true,endpoint};
 expect(await speechStatus(settings)).toMatchObject({available:true,backend:'whisper-server'});
 const runner=new SpeechTranscriber(root);
 expect(await runner.transcribe(wav,settings)).toEqual({text:'Local server transcript.'});
 expect(received).toEqual({format:'json',language:'auto',file:wav,type:'audio/wav'});
 expect(fs.existsSync(root)).toBe(false);
});
it('rejects non-loopback endpoints, redirects, invalid JSON and oversized transcripts',async()=>{
 for(const endpoint of ['https://example.com','http://192.168.1.4:8080','http://127.0.0.1:8080/path','http://user:password@localhost','http://localhost/?token=secret'])
  expect(()=>parseSpeech({...DEFAULT_SPEECH,endpoint})).toThrow();
 let mode='redirect';let forwarded=0;
 const endpoint=await listen((req,res)=>{
  if(req.url==='/forwarded')forwarded++;
  if(mode==='redirect'){res.writeHead(307,{Location:'/forwarded'});res.end();}
  else if(mode==='oversized'){res.writeHead(200);res.end('x'.repeat(1024*1024+1));}
  else{res.writeHead(200);res.end('invalid json');}
 });
 const runner=new SpeechTranscriber(root),settings={...DEFAULT_SPEECH,enabled:true,endpoint};
 await expect(runner.transcribe(Buffer.alloc(44),settings)).rejects.toMatchObject({status:503});
 expect(forwarded).toBe(0);
 mode='oversized';await expect(runner.transcribe(Buffer.alloc(44),settings)).rejects.toMatchObject({status:502});
 mode='invalid';await expect(runner.transcribe(Buffer.alloc(44),settings)).rejects.toMatchObject({status:502});
});
it('serializes local HTTP inference and propagates cancellation without a fallback',async()=>{
 let started!:()=>void;const arrived=new Promise<void>(r=>{started=r;});
 const endpoint=await listen((_req,_res)=>started());
 const runner=new SpeechTranscriber(root),settings={...DEFAULT_SPEECH,enabled:true,endpoint},controller=new AbortController();
 const request=runner.transcribe(Buffer.alloc(44),settings,controller.signal);
 await arrived;
 await expect(runner.transcribe(Buffer.alloc(44),settings)).rejects.toMatchObject({status:409});
 controller.abort();await expect(request).rejects.toMatchObject({status:499});
});
it('starts new installations with standalone speech disabled and preserves legacy MyWhispr settings',async()=>{
 expect(DEFAULT_SPEECH).toMatchObject({backend:'whisper-server',enabled:false});
 const db=await initTestDb();await runMigrations(db);
 const previous={enabled:true,executable:'/example/mywhispr',model:'parakeet-tdt-v3',language:'ru'};
 await db.run('INSERT INTO ws_settings VALUES (?,?)','workspace',JSON.stringify({theme:'dark',speech:previous}));
 await workspaceSpeechBackendsMigration.up(db);
 expect((await new WorkspaceStore(db).settings()).speech).toMatchObject({...previous,backend:'mywhispr'});
 await workspaceSpeechBackendsMigration.up(db);
 expect((await new WorkspaceStore(db).settings()).speech).toMatchObject({...previous,backend:'mywhispr'});
});
it('also preserves existing installations that used the original implicit MyWhispr defaults',async()=>{
 const db=await initTestDb();await runMigrations(db);
 await db.run('INSERT INTO ws_settings VALUES (?,?)','workspace',JSON.stringify({theme:'dark'}));
 await workspaceSpeechBackendsMigration.up(db);
 expect((await new WorkspaceStore(db).settings()).speech).toMatchObject({enabled:true,backend:'mywhispr',model:'large-v3-v20240930_626MB'});
});

it('validates the selected backend without blocking it on unused settings',()=>{
 expect(parseSpeech({...DEFAULT_SPEECH,backend:'mywhispr',endpoint:'unfinished server address'}).backend).toBe('mywhispr');
 expect(()=>parseSpeech({...DEFAULT_SPEECH,endpoint:'unfinished server address'})).toThrow();
 expect(parseSpeech({...DEFAULT_SPEECH,executable:'unused CLI draft',model:'unused model'}).backend).toBe('whisper-server');
 expect(()=>parseSpeech({...DEFAULT_SPEECH,backend:'mywhispr',executable:'unused CLI draft'})).toThrow();
});
