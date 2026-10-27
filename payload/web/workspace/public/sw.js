/* Only the public shell is cached. Private APIs and attachments always use the network. */
const CACHE = 'nanoclaw-shell-__BUILD__';
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache=await caches.open(CACHE);
  const shell=await fetch('/',{cache:'reload'});
  if(!shell.ok)throw new Error('Workspace shell unavailable');
  const html=await shell.clone().text();await cache.put('/',shell);
  const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(m=>m[1]);
  await cache.addAll([...new Set([...assets,'/icon.svg','/favicon.ico','/icon-192.png','/icon-512.png','/apple-touch-icon.png'])]);
} )()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('nanoclaw-shell-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('message',event=>{if(event.data?.type==='activate')self.skipWaiting();});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||event.request.method!=='GET'||url.pathname.startsWith('/api/'))return;
  if(event.request.mode==='navigate'&&url.pathname==='/') {
    event.respondWith(fetch(event.request).catch(async()=>{const cached=await caches.match('/');return cached??Response.error();}));return;
  }
  if(url.pathname.startsWith('/assets/')||/^\/(icon-(192|512)\.png|apple-touch-icon\.png|icon\.svg|favicon\.ico)$/.test(url.pathname))event.respondWith((async()=>{
    const cached=await caches.match(event.request);if(cached)return cached;
    const response=await fetch(event.request);if(response.ok)(await caches.open(CACHE)).put(event.request,response.clone());return response;
  })());
});
self.addEventListener('push',event=>event.waitUntil((async()=>{
  let data={};try{data=event.data?.json()??{};}catch{}
  const notification=data.notification??{title:'NanoClaw',body:'New workspace activity',navigate:self.location.origin};
  const url=new URL(notification.navigate??'/',self.location.origin);
  const navigate=url.origin===self.location.origin&&url.pathname==='/'?url.href:self.location.origin;
  const options={body:notification.body??'New workspace activity',tag:notification.tag,icon:'/icon-192.png',data:{navigate},badge:'/icon-192.png'};
  // Declarative-capable Safari can display this fallback without worker code.
  await self.registration.showNotification(notification.title??'NanoClaw',options);
  const count=Number(notification.app_badge??0);
  try {if(count)await self.navigator.setAppBadge?.(count);else await self.navigator.clearAppBadge?.();}catch{}
})()));
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const candidate=event.notification.data?.navigate??self.location.origin;
    const url=new URL(candidate,self.location.origin);
    const target=url.origin===self.location.origin&&url.pathname==='/'?url.href:self.location.origin;
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const app=clients.find(c=>new URL(c.url).origin===self.location.origin);
    if(app){await app.navigate(target);await app.focus();}else await self.clients.openWindow(target);
  })());
});
