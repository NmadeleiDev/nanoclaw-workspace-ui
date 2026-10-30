import {it,expect} from 'vitest';
import {timelineText} from '../src/timeline-output';
it('only consumes exact delivered blocks once and keeps commentary',()=>{
 const delivered=['Final'];
 expect(timelineText('Before <message to="user">Final</message> after',delivered)).toBe('Before  after');
 expect(timelineText('<message>Final</message>',delivered)).toBe('Final');
 expect(timelineText('plain commentary',[])).toBe('plain commentary');
});
