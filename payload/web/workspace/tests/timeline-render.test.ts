import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it,expect} from 'vitest';
import {OutputTimeline} from '../src/timeline';
it('renders reasoning as a collapsed running preview and preserves tool summary descriptions and actions',()=>{
 const markup=renderToStaticMarkup(React.createElement(OutputTimeline,{
  running:true,entries:[
   {id:'r',kind:'reasoning',text:'beginning of reasoning '+'.'.repeat(300)+'latest reasoning'},
   {id:'t',kind:'tool',name:'Read',status:'completed'},
  ],
  toolLabel:React.createElement('span',{className:'activity-label'},React.createElement('strong',null,'Worked'),React.createElement('small',null,'Read the Jira comments successfully.')),
  toolAction:React.createElement('button',null,'Summarize activity'),
 }));
 expect(markup).toContain('class="reasoning-trace work-row"');
 expect(markup).toContain('Thinking');
 expect(markup).toContain('latest reasoning');
 expect(markup).not.toContain('beginning of reasoning');
 expect(markup).not.toContain('<details class="reasoning-trace work-row" open');
 expect(markup).toContain('Read the Jira comments successfully.');
 expect(markup).toContain('1 step');
 expect(markup).toContain('Summarize activity');
});
it('keeps alternating reasoning and calls inside one work container, split only by ordinary text',()=>{
 const entries=[
  {id:'r1',kind:'reasoning' as const,text:'first thought'},
  {id:'t1',kind:'tool' as const,name:'Read',status:'completed'},
  {id:'r2',kind:'reasoning' as const,text:'second thought'},
  {id:'t2',kind:'tool' as const,name:'Search',status:'completed'},
 ];
 const markup=renderToStaticMarkup(React.createElement(OutputTimeline,{entries}));
 expect(markup.match(/class="live-tools"/g)).toHaveLength(1);
 expect(markup.match(/class="reasoning-trace work-row"/g)).toHaveLength(2);
 expect(markup).toContain('2 steps');
 expect(markup.indexOf('first thought')).toBeLessThan(markup.indexOf('Read'));
 expect(markup.indexOf('Read')).toBeLessThan(markup.indexOf('second thought'));
 expect(markup.indexOf('second thought')).toBeLessThan(markup.indexOf('Search'));
 const split=renderToStaticMarkup(React.createElement(OutputTimeline,{entries:[...entries,{id:'text',kind:'text',text:'User-facing update'},...entries.map(e=>({...e,id:'next-'+e.id}))]}));
 expect(split.match(/class="live-tools"/g)).toHaveLength(2);
 expect(split).toContain('User-facing update');
});
