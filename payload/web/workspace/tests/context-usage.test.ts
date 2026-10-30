import {expect,it} from 'vitest';
import {contextUsageDisplay} from '../src/context-usage';
const value={usedTokens:50000,contextWindow:100000,model:'byteplus/example',estimated:true};
it('shows latest occupancy, including low usage and over-limit values',()=>{
 expect(contextUsageDisplay(value).label).toBe('Context ~50%');
 expect(contextUsageDisplay({...value,usedTokens:100}).label).toBe('Context ~0.1%');
 expect(contextUsageDisplay({...value,usedTokens:120000}).label).toBe('Context ~120%');
 expect(contextUsageDisplay(value).tokens).toBe('(50,000/100,000)');
 expect(contextUsageDisplay(value).title).toContain('50,000 / 100,000');
});
it('keeps unavailable and changed-model readings honest',()=>{
 expect(contextUsageDisplay(undefined).tokens).toBeNull();
 expect(contextUsageDisplay(value,'byteplus/other').tokens).toBeNull();
 expect(contextUsageDisplay({...value,contextWindow:null}).tokens).toBeNull();
 expect(contextUsageDisplay(undefined).label).toBe('Context —');
 expect(contextUsageDisplay({...value,contextWindow:null}).percent).toBeNull();
 expect(contextUsageDisplay(value,'byteplus/other').percent).toBeNull();
 expect(contextUsageDisplay({...value,model:'claude-sonnet-example'},'sonnet').percent).toBe(50);
});
