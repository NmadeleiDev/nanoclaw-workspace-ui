import {expect,test} from 'bun:test';
import {openCodeContextUsage,claudeContextUsage} from './context-usage.js';
test('counts the latest OpenCode footprint including cache and separate reasoning tokens',()=>{
 const info={role:'assistant',providerID:'byteplus',modelID:'example',tokens:{input:200,output:30,reasoning:20,cache:{read:700,write:50}}};
 expect(openCodeContextUsage(info,2000)).toEqual({usedTokens:1000,contextWindow:2000,model:'byteplus/example',estimated:true});
 expect(openCodeContextUsage({...info,tokens:{input:50,output:10}},2000)?.usedTokens).toBe(60);
 expect(openCodeContextUsage(info)?.contextWindow).toBeNull();
 expect(openCodeContextUsage({...info,role:'user'},2000)).toBeNull();
 expect(openCodeContextUsage({...info,tokens:{input:0,output:0}},2000)).toBeNull();
 expect(openCodeContextUsage({...info,tokens:{input:-1}},2000)).toBeNull();
});
test('reads Claude local summary context instead of cumulative model usage',async()=>{
 let detail:unknown;
 const usage=await claudeContextUsage({getContextUsage:async(options)=>{detail=options;return {totalTokens:500,rawMaxTokens:1000,model:'claude-example'};}});
 expect(detail).toEqual({detail:'summary'});expect(usage?.usedTokens).toBe(500);expect(usage?.contextWindow).toBe(1000);
 expect(await claudeContextUsage({})).toBeNull();
 expect(await claudeContextUsage({getContextUsage:async()=>{throw new Error('unsupported');}})).toBeNull();
});
