import {it,expect} from 'bun:test';
import {OpenCodeDisplay} from './opencode-display.js';
it('classifies reasoning and reconciles snapshots without appending them',()=>{
 const display=new OpenCodeDisplay();
 const part={id:'p',sessionID:'s',messageID:'m',type:'reasoning',text:''};
 expect(display.accept('message.part.updated',{part})[0]).toMatchObject({data:{partType:'reasoning',text:''}});
 expect(display.accept('message.part.delta',{sessionID:'s',messageID:'m',partID:'p',field:'text',delta:'why'})[0]).toMatchObject({data:{delta:'why',partType:'reasoning'}});
 expect(display.accept('message.part.updated',{part:{...part,text:'why',time:{end:1}}})[0]).toMatchObject({data:{text:'why',complete:true}});
 expect(display.accept('message.part.updated',{part:{...part,synthetic:true}})).toEqual([]);
});
it('excludes user and synthetic parts and keeps descendant identities separate',()=>{
 const display=new OpenCodeDisplay();
 display.accept('message.updated',{info:{sessionID:'s',id:'m',role:'user'}});
 expect(display.accept('message.part.updated',{part:{id:'p',sessionID:'s',messageID:'m',type:'text',text:'incoming'}})).toEqual([]);
 display.accept('message.part.updated',{part:{id:'p',sessionID:'s',messageID:'a',type:'text',synthetic:true}});
 expect(display.accept('message.part.delta',{sessionID:'s',messageID:'a',partID:'p',field:'text',delta:'context'})).toEqual([]);
 const event=display.accept('message.part.updated',{part:{id:'p',sessionID:'child',messageID:'a',type:'reasoning',text:'why'}})[0];
 expect(event).toMatchObject({id:'child:a:p',data:{sourceSessionId:'child',partType:'reasoning'}});
});
