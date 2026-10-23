const CACHE_NAME='gestok-web-control-v51-16';

const APP_SHELL=[
  './manifest.webmanifest',
  './parking-ticket.html',
  './restaurant-menu.html',
  './gestok-icon-192.png',
  './gestok-icon-512.png'
];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>cache.addAll(APP_SHELL))
      .catch(()=>null)
  );

  self.skipWaiting();
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys
        .filter(key=>key!==CACHE_NAME)
        .map(key=>caches.delete(key))
    ))
  );

  self.clients.claim();
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;

  const req=event.request;
  const url=new URL(req.url);

  // El HTML principal siempre intenta cargarse desde internet.
  // Así evitamos que una versión vieja de GestOK quede guardada.
  if(
    req.mode==='navigate' ||
    url.pathname.endsWith('/index.html') ||
    url.pathname==='/'
  ){
    event.respondWith(
      fetch(req,{cache:'no-store'})
        .then(response=>response)
        .catch(()=>
          caches.match('./index.html')
            .then(cached=>cached||Response.error())
        )
    );

    return;
  }

  event.respondWith(
    caches.match(req).then(cached=>{
      const network=fetch(req)
        .then(response=>{
          if(response&&response.ok){
            const copy=response.clone();

            caches.open(CACHE_NAME)
              .then(cache=>cache.put(req,copy))
              .catch(()=>{});
          }

          return response;
        })
        .catch(()=>cached);

      return cached||network;
    })
  );
});

self.addEventListener('push',event=>{
  let data={};

  try{
    data=event.data
      ?event.data.json()
      :{};
  }catch{
    data={
      body:event.data
        ?event.data.text()
        :'Tenés una nueva notificación.'
    };
  }

  const title=
    data.title||
    'GestOK Web Control';

  const options={
    body:
      data.body||
      'Tenés una nueva notificación.',

    icon:'./gestok-icon-192.png',
    badge:'./gestok-icon-192.png',

    tag:
      data.tag||
      'gestok',

    renotify:true,

    data:{
      url:
        data.url||
        './?open=gestok'
    }
  };

  event.waitUntil(
    self.registration.showNotification(
      title,
      options
    )
  );
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();

  const target=
    event.notification?.data?.url||
    './?open=gestok';

  event.waitUntil(
    clients
      .matchAll({
        type:'window',
        includeUncontrolled:true
      })
      .then(windowClients=>{

        for(const client of windowClients){
          if('focus' in client){
            client.navigate(target);
            return client.focus();
          }
        }

        if(clients.openWindow){
          return clients.openWindow(target);
        }

      })
  );
});
