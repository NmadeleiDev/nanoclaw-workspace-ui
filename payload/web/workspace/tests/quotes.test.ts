import {expect,it} from 'vitest';
import {appendQuote} from '../src/quotes';
it('quotes a selection as Markdown and leaves a blank line for the reply',()=>{
 expect(appendQuote('', 'DIN-1873 — review the dashboard.')).toBe('> DIN-1873 — review the dashboard.\n\n');
 expect(appendQuote('', 'First line\r\n\r\nSecond line')).toBe('> First line\n>\n> Second line\n\n');
});
it('keeps the existing draft, separates successive quotes, and preserves Unicode',()=>{
 expect(appendQuote('My existing draft', 'Первая строка 😀')).toBe('My existing draft\n\n> Первая строка 😀\n\n');
 expect(appendQuote('Draft\n', 'Quote')).toBe('Draft\n\n> Quote\n\n');
 expect(appendQuote('Draft\n\n', 'Quote')).toBe('Draft\n\n> Quote\n\n');
 expect(appendQuote(appendQuote('', 'One'), 'Two')).toBe('> One\n\n> Two\n\n');
 expect(appendQuote('Keep this', ' \n ')).toBe('Keep this');
});
