/** Consume exact delivery blocks once, within the originating turn only. */
export function timelineText(text: string, delivered: string[]): string {
  return text.replace(/<message\b[^>]*>([\s\S]*?)<\/message>/g, (whole,body:string)=>{
    const index=delivered.findIndex(value=>value.trim()===body.trim());
    if(index<0)return body;
    delivered.splice(index,1);return '';
  }).replace(/<\/?message\b[^>]*>/g,'');
}
