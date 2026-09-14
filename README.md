# MakerWorld Points Tracker

Extensión de Chrome (Manifest V3) que lleva el control diario de los puntos que
ganás en MakerWorld y separa cuánto viene de **boosts** y cuánto de tus
**diseños**.

## Cómo obtiene los datos

MakerWorld no tiene API pública y su WAF rechaza cualquier request hecha desde
fuera del navegador (403 a todo, exista o no la ruta). Por eso la extensión **no
hardcodea endpoints**: los aprende sola.

1. `src/sniffer.js` corre en el mundo `MAIN` de makerworld.com y envuelve `fetch`
   y `XMLHttpRequest`. Mira pasar las llamadas reales de la página y se queda con
   las que van a `/api/*` y mencionan puntos.
2. De cada una guarda un *perfil*: URL, método y headers replicables
   (`authorization`, `x-*`, etc.).
3. `src/lib/parse.js` recorre el JSON buscando arrays de objetos que tengan una
   cantidad y una fecha, sin asumir un esquema concreto.
4. Al sincronizar, el service worker le pide al sniffer que re-emita esa misma
   request pagina por página (`offset`, `page` o cursor) hasta que una página no
   aporte registros nuevos. Como la request sale desde la propia pestaña, lleva
   la sesión y los headers correctos y el WAF no la bloquea.

## Instalación

```
chrome://extensions → Modo desarrollador → Cargar descomprimida → esta carpeta
```

## Uso

1. Iniciá sesión en makerworld.com y entrá a tu historial de puntos.
2. Desplazate por la lista: ahí la extensión captura el endpoint.
3. Abrí el popup y tocá **Sincronizar** para traer el histórico hacia atrás.

A partir de ahí se sincroniza sola cada 3 horas (con una pestaña de MakerWorld
abierta) y todo lo que veas navegando se guarda al pasar.

## Clasificación boost / diseño

Vive en `classify()` en [`src/lib/parse.js`](src/lib/parse.js) y es una
heurística sobre el texto del registro (`type`, `title`, `source`, …). Es lo
primero que va a necesitar ajuste cuando veamos los textos reales: la tabla
**Clasificación** de la página de diagnóstico muestra cada etiqueta encontrada y
en qué categoría cayó, así se corrige mirando datos y no adivinando.

## Diagnóstico

Popup → *Diagnóstico*. Lista endpoints capturados, las etiquetas con su
clasificación, los registros crudos, y exporta a JSON o CSV.

## Datos

Todo queda local en `chrome.storage.local`. No sale nada hacia ningún servidor.

## Tests

```
npm test
```

Cubren el parser (dos formas de JSON plausibles, ruido, epoch en segundos vs ms),
la detección de paginación y la agregación diaria.

## Limitaciones conocidas

- Los endpoints se descubren por heurística de URL (`point|credit|reward|…`). Si
  MakerWorld usa otro nombre, hay que ampliar `POINT_URL_RE` en el sniffer.
- La deduplicación usa el `id` del registro cuando existe; si la API no lo trae,
  cae en una clave sintética (fecha + monto + texto) que podría colapsar dos
  registros idénticos del mismo día.
- Solo Chromium. Para Firefox haría falta un build aparte (`browser.*` +
  polyfill), porque `world: "MAIN"` en content scripts se declara distinto.
