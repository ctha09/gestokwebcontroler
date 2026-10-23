const CACHE_NAME='gestok-web-control-v51-14';

const APP_SHELL=[
  './',
  './index.html',
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

  event.respondWith(
    fetch(event.request)
      .then(response=>{
        const copy=response.clone();

        caches.open(CACHE_NAME)
          .then(cache=>cache.put(event.request,copy))
          .catch(()=>{});

        return response;
      })
      .catch(()=>
        caches.match(event.request)
          .then(cached=>
            cached||
            caches.match('./index.html')
          )
      )
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
