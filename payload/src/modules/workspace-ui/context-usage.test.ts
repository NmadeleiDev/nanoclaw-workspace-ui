import fs from 'node:fs';
import {expect,it} from 'vitest';
import {parseContextUsage} from './context-usage.js';
it('validates context telemetry without manufacturing an unknown window',()=>{
 expect(parseContextUsage({usedTokens:100,contextWindow:1000,model:'model'})).toMatchObject({usedTokens:100,contextWindow:1000,estimated:true});
 for(const usedTokens of [-1,NaN,Infinity,'100',1.2])expect(parseContextUsage({usedTokens,contextWindow:1000})).toBeNull();
 expect(parseContextUsage({usedTokens:100,contextWindow:0})?.contextWindow).toBeNull();
 expect(parseContextUsage({usedTokens:2000,contextWindow:1000})?.usedTokens).toBe(2000);
});
it('keeps the runner wire contract byte-identical',()=>{
 expect(fs.readFileSync('container/agent-runner/src/context-usage.generated.ts','utf8')).toBe(fs.readFileSync('src/modules/workspace-ui/context-usage.ts','utf8'));
});
