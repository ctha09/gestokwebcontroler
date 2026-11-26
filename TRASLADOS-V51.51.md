# Web Control V51.51 · Traslados

## 25 de noviembre de 2026

La rama `feature/traslados-v51-51` incorpora el sector `transport` al selector y a la restauración de sesiones del mismo `index.html`. Usa el usuario, la membresía de empresa y la suscripción de Supabase que corresponden al alta de GestOK Control V30. El acceso requiere que el RPC existente `gestok_org_access_status` autorice a esa organización.

El panel del conductor tiene Inicio, Mapa, Pedidos, Historial, Estadísticas y Código de acceso. La navegación queda al pie en pantallas de hasta 650 px. El mapa interactivo se carga al abrir la sección y no pide la ubicación del dispositivo.

V40 reserva `transport_settings` para el servidor y bloquea la activación de solicitudes públicas. Pedidos, Historial, Estadísticas y Código de acceso muestran el estado de esta etapa. La futura vista de pasajero y el acceso controlado al código se incorporarán al mismo sitio. Esta rama no introduce cambios de base de datos.

Verificado en Microsoft Edge con Supabase simulado. Se probaron el acceso por alias, una contraseña incorrecta, el rechazo de sector equivocado, la restauración y el cierre de sesión, el bloqueo por prueba vencida y el fallo al verificar la suscripción. Se comprobó el despacho a los otros cuatro sectores y la navegación del panel a 320, 390, 768 y 1280 px. Queda pendiente probar con cuentas V30 en un Supabase aislado.

## V51.52 · 25 de noviembre de 2026

- V41 requiere V40. Agrega `transport_requests`, `transport_trips` y `transport_receipts` sin cambiar el UUID permanente. Solo los miembros activos de la organización de Traslados con acceso conforme a la suscripción pueden leer pedidos y viajes. El punto de recogida es privado de esa organización. El pasajero solo recibe la proyección de su propio estado con su comprobante aleatorio. La base guarda la huella del comprobante. El navegador guarda el comprobante en la sesión de la pestaña, separado del enlace compartido.
- El enlace estable usa `https://gestokwebcontrol.online/?traslado=<uuid>`. El QR se genera en el navegador. El pasajero puede ingresar el punto manualmente o compartir su ubicación, solicitar para ahora o en 10, 20, 30 o 60 minutos, o programar una fecha y hora futura.
- El conductor recibe cambios de `transport_requests` por Realtime, filtrados por organización, con reconsulta periódica. Hay aviso visual y sonido opcional. Los pedidos con ubicación compartida se marcan en Leaflet. Los pedidos ingresados como dirección manual están en la lista. Las acciones piden confirmar con el vehículo detenido. El historial y los importes se calculan con los viajes guardados.
- V41 conserva el bloqueo de V40 sobre `requests_enabled`. Para probar el envío completo, quitar ese bloqueo y habilitar únicamente las organizaciones ficticias en una base aislada y descartable. Cualquier habilitación posterior requiere una migración específica aprobada. En la base de pruebas conviene verificar que el esquema quedó en falso antes de habilitarlo. La función pública limita las ráfagas a 30 nuevas solicitudes por organización cada 10 minutos y resuelve reintentos con el mismo comprobante de forma idempotente.
- Leaflet 1.9.4 y QR Code Generator 2.0.4 están incluidos con sus licencias en `assets/traslados`. Solo la cartografía se carga desde OpenStreetMap al abrir el mapa. No se envían direcciones, importes ni comprobantes al servicio cartográfico.

### Pruebas locales de V51.52

La suite SQL usa PostgreSQL 17.5 en memoria, el esquema ficticio del administrador y las migraciones V40 y V41. Desde `gestokwebcontroler`, con Node.js 24:

```powershell
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('gestok-v41-' + [guid]::NewGuid().ToString('N'))
npm.cmd install --prefix $testDir --no-audit --no-fund @electric-sql/pglite@0.3.15
$env:GESTOK_PGLITE_MODULE = Join-Path $testDir 'node_modules/@electric-sql/pglite/dist/index.js'
node --test tests/traslados-v41.test.mjs
```

Si el repositorio del administrador está en otra ubicación, indicar su carpeta con `GESTOK_ADMIN_REPO`. Para la integración completa con el gateway aislado, usar una copia temporal del sitio con la URL y la clave publicable de ese stack. Verificar Auth, RPC y WebSocket entre dos conductores de organizaciones distintas y dos pestañas de pasajeros. No reutilizar credenciales ni URL de producción en esa copia.

Resultados del 25 de noviembre de 2026:

- V41 pasó las 6 pruebas de PostgreSQL. Se comprobaron el bloqueo público, los UUID de V40, los horarios, el reintento idempotente, el aislamiento entre organizaciones y comprobantes, las demoras permitidas, el viaje completo con importe, el rechazo y el acceso ante vencimiento de una suscripción.
- Las 14 regresiones de V30 volvieron a pasar, incluidas las reglas de SCR y Carlos.
- Microsoft Edge completó el flujo de conductor y pasajero con un backend ficticio. Se comprobaron QR, copia y compartir, ubicación voluntaria y recogida manual, estado al recargar, marcador, aviso y emisión de tono, acciones, historial, estadísticas y cierre. Ambos paneles se verificaron a 320, 390, 768 y 1280 px.
- La conexión real por WebSocket y el recorrido integral con Auth y PostgREST quedan pendientes en el stack aislado. Esta estación todavía no dispone de Docker.

## V51.53 · 25 de noviembre de 2026

- Inicio muestra el balance diario y ofrece accesos para registrar viajes y gastos. Los viajes manuales pueden ser realizados o cancelados. Gastos acepta combustible, mantenimiento, estacionamiento, peajes y otros con descripción.
- V42 liquida los viajes en `transport_trips`. El importe y el medio de pago se guardan junto con el cierre en una sola transacción. Cada viaje completado cuenta una vez como ingreso. El mismo cierre con el mismo importe y medio se puede reintentar. Los registros manuales de viajes y gastos usan un UUID por operación para deduplicar reintentos.
- El historial separa viajes realizados, cancelados y pedidos rechazados. Filtra por fecha de cierre o registro, estado y medio de pago. Los detalles excluyen coordenadas y comprobantes. Los viajes históricos conservan sus importes y muestran «Sin medio registrado» cuando no había un medio de pago guardado.
- El tablero calcula ingresos, egresos, ganancia neta, viajes, promedio y picos de actividad con SQL. El corte es en la zona horaria de Buenos Aires y la semana empieza el lunes. Los viajes históricos sin importe cuentan como actividad y quedan excluidos del promedio monetario. El gráfico diario agrupa por hora. Los gráficos semanales y mensuales agrupan por día.
- V42 solo modifica las tablas de Traslados y requiere V40 y V41. Las solicitudes públicas siguen bloqueadas por V40. Para una instalación autorizada, validar primero V42 en un entorno aislado y publicar V51.53 inmediatamente después de aplicar la migración. Un cliente V51.52 aún en caché deberá recargar para finalizar viajes, porque el medio de pago ahora es obligatorio.

### Pruebas locales de V51.53

Usar la misma configuración de PGlite indicada para V51.52 y ejecutar:

```powershell
node --test tests/traslados-v41.test.mjs tests/traslados-v42.test.mjs
```

Pasaron 12 pruebas de PostgreSQL 17.5 entre V41 y V42. La suite cubre la conservación de datos, el bloqueo público, el importe y medio de pago requeridos, la reversión de un cierre inválido, los reintentos de cierre, viajes y gastos, los filtros, los cortes diarios, semanales y mensuales, las agregaciones y los permisos de las demás organizaciones y sectores.

Pasaron también las 14 regresiones de V30, incluidas SCR y Carlos. En Edge se verificaron el balance actualizado, el viaje manual, el cierre con medio obligatorio, el gasto personalizado, el historial con filtros combinados y detalles, los tres períodos del gráfico, la restauración y el QR con solicitudes bloqueadas. La prueba usó registros ficticios en PostgreSQL 17.5 a través de un servidor local y comprobó el panel a 320, 390, 768 y 1280 px. Auth, PostgREST y Realtime se simularon en la prueba del navegador, por lo que queda pendiente la integración con un Supabase aislado.

## Validación integral · 25 de noviembre de 2026

**Resultado.** Pasaron 28 pruebas locales entre V30, V41, V42 y el service worker. V40, V41 y V42 se aplicaron a datos ficticios en PostgreSQL 17.5 en memoria. En Edge, dos contextos de pasajero separados enviaron solicitudes al mismo conductor, y cada uno conservó su propio comprobante. Se cortó la red, se restauró y se simuló una respuesta perdida después del registro. El reintento con el mismo comprobante conservó una sola solicitud. También se verificaron el cierre de sesión, los estados, el historial, el balance y los gráficos. El navegador solamente habló con un servidor local. Auth, PostgREST y Realtime se simularon.

**Problema corregido.** El service worker podía poner respuestas GET de Supabase en CacheStorage, compartido por las sesiones del mismo navegador. Las consultas a Supabase y las peticiones autenticadas ahora van a red con `no-store`. El cambio de versión elimina la caché anterior al activar el nuevo worker. Dos pruebas verifican que esas consultas eviten la caché y que los archivos estáticos sigan disponibles en ella.

**Privacidad.** Los comprobantes del pasajero quedan fuera de la URL y de la publicación de Realtime. El endpoint de estado devuelve solo el estado, horario, demora e importe de la solicitud correspondiente, además de identificador y versión. Las coordenadas no aparecen en el historial financiero. Los permisos SQL aislaron las dos organizaciones ficticias y los otros sectores. Los azulejos de OpenStreetMap pueden revelar el área visualizada al proveedor, aunque GestOK no envía direcciones ni datos financieros en esas llamadas.

**Pendiente para autorizar la publicación.**

1. Habilitar WSL 2 e instalar e iniciar Docker Desktop en esta estación. El comando `docker version` debe mostrar cliente y servidor.
2. Desde el repositorio del administrador ejecutar `powershell -NoProfile -ExecutionPolicy Bypass -File tests/start-traslados-local.ps1 -WebControlPath ..\gestokwebcontroler`. El lanzador aislado incluye V40, V41, V42 y la activación exclusiva de cuentas ficticias, y prepara pruebas reales de Auth, Edge Function, gateway y WebSocket.
3. Repetir en un navegador con el gateway del stack aislado. Verificar el alta desde el formulario V30, ingreso V51.53, dos pasajeros, eventos de dos organizaciones, desconexión/reconexión, cierre y expiración real de sesiones. Repetir la matriz funcional de Comercio, Barbería, Restaurante y Estacionamiento con las particularidades de SCR y Carlos. Las regresiones automatizadas no cubren todos los flujos de navegador de esos sectores.
4. Revisar el tratamiento de ubicaciones antes de abrir solicitudes y confirmar la actualización del service worker en una PWA ya instalada. Mantener V40 y las solicitudes públicas bloqueadas en producción hasta la aprobación.
