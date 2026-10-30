// Canavida — Cloudflare Worker
// Sirve la app (archivos estáticos) y la API:
//   GET  /api/reserva?nombre=&apellidos=   → verifica al huésped en Lodgify + disponibilidad de extras
//   POST /api/solicitud                    → envía correo al equipo (admicanavida@gmail.com)
//   POST /api/chat                         → asistente con IA (FAQ del repositorio + memoria en D1)
// Secretos:  LODGIFY_API_KEY, RESEND_API_KEY
// Bindings:  ASSETS (archivos), AI (Workers AI), DB (D1)

const TEAM_EMAIL = 'admicanavida@gmail.com';
const WAZE = 'https://www.waze.com/en/live-map/directions/cr/provincia-de-puntarenas/uvita/canavida-villas-and-resort?place=ChIJz3gMGphXoY8R1QERaYsYZdg';
const APP_PAGE = '/Canavida%20App.dc.html';

const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const addDays = (iso, n) => { const d = new Date(iso.slice(0, 10) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/reserva') return await reserva(url, env);
      if (url.pathname === '/api/solicitud' && req.method === 'POST') return await solicitud(await req.json(), env);
      if (url.pathname === '/api/chat' && req.method === 'POST') return await chat(await req.json(), env, url);
      if (url.pathname === '/api/traducir' && req.method === 'POST') return await traducir(await req.json(), env);
    } catch (e) {
      return json({ error: e.message || 'error' }, 500);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return env.ASSETS.fetch(new Request(new URL(APP_PAGE, url), req));
    }
    return env.ASSETS.fetch(req);
  }
};

// ─── Lodgify ────────────────────────────────────────────────────────────
async function lodgify(path, env) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch('https://api.lodgify.com' + path, {
      headers: { 'X-ApiKey': (env.LODGIFY_API_KEY || '').trim(), accept: 'application/json' }
    });
    if (r.status === 429) { await sleep((Number(r.headers.get('retry-after')) || 2) * 1000); continue; }
    if (!r.ok) throw new Error('Lodgify respondió ' + r.status + (r.status === 401 ? ' (API key incorrecta)' : ''));
    return r.json();
  }
  throw new Error('Lodgify está limitando las consultas, intente en unos minutos');
}

// Reservas en curso + próximas. Se guardan 10 min en D1 para no saturar Lodgify.
async function bookings(env) {
  const row = await env.DB.prepare('SELECT v, t FROM cache WHERE k = ?').bind('bookings').first();
  if (row && Date.now() - row.t < 10 * 60 * 1000) return JSON.parse(row.v);
  const items = [];
  for (const filtro of ['Current', 'Upcoming']) {
    for (let page = 1; page <= 6; page++) {
      const d = await lodgify(`/v2/reservations/bookings?stayFilter=${filtro}&page=${page}&size=50&includeExternal=true`, env);
      const list = d.items || [];
      for (const b of list) {
        if (/declin|cancel|open/i.test(b.status || '')) continue;
        const room = b.rooms?.[0] || {};
        const g = room.guest_breakdown;
        items.push({
          id: b.id,
          name: b.guest?.name || '',
          email: b.guest?.email || '',
          phone: b.guest?.phone || '',
          source: b.source || '',
          property: b.property_id,
          roomType: room.room_type_id || null,
          villa: room.name || b.property_name || 'Canavida',
          arrival: (b.arrival || '').slice(0, 10),
          departure: (b.departure || '').slice(0, 10),
          guests: g ? (g.adults || 0) + (g.children || 0) + (g.infants || 0) : (room.people || 1)
        });
      }
      if (list.length < 50) break;
    }
  }
  await env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, t) VALUES (?, ?, ?)').bind('bookings', JSON.stringify(items), Date.now()).run();
  return items;
}

// Disponibilidad de extras según las demás reservas de la MISMA villa.
function offersFor(b, all) {
  const same = all.filter(o => o.id !== b.id && o.property === b.property && (!b.roomType || !o.roomType || o.roomType === b.roomType));
  const occupied = night => same.some(o => o.arrival <= night && night < o.departure);
  let extendNights = 0;
  while (extendNights < 3 && !occupied(addDays(b.departure, extendNights))) extendNights++;
  return {
    extendNights,                                            // noches libres justo después de su salida (máx. 3)
    early: !same.some(o => o.departure === b.arrival),       // nadie sale de la villa el día que usted llega
    late: !same.some(o => o.arrival === b.departure),        // nadie llega a la villa el día que usted sale
    wine: true                                               // siempre disponible
  };
}

async function findBooking(nombre, apellidos, env) {
  const all = await bookings(env);
  const partes = norm(apellidos).split(/\s+/).filter(Boolean);
  const n1 = norm(nombre);
  const b = all.find(x => { const n = norm(x.name); return n.includes(n1) && partes.some(a => n.includes(a)); });
  return { b, all };
}

async function reserva(url, env) {
  const nombre = url.searchParams.get('nombre');
  const apellidos = url.searchParams.get('apellidos');
  if (!norm(nombre) || !norm(apellidos)) return json({ notFound: true });
  if (!env.LODGIFY_API_KEY) return json({ error: 'Falta el secreto LODGIFY_API_KEY en Cloudflare' }, 500);
  const { b, all } = await findBooking(nombre, apellidos, env);
  if (!b) return json({ notFound: true });
  const [first, ...rest] = b.name.trim().split(/\s+/);
  const nights = Math.round((new Date(b.departure) - new Date(b.arrival)) / 864e5);
  // Solo devolvemos lo que la app necesita — nunca correo, teléfono ni montos.
  return json({ first, last: rest.join(' '), villa: b.villa, arrival: b.arrival, departure: b.departure, nights, guests: b.guests, code: String(b.id), offers: offersFor(b, all) });
}

// ─── Solicitudes → correo al equipo ─────────────────────────────────────
const TIPOS = {
  extend: 'Extender estadía', early: 'Early check-in', late: 'Late check-out',
  wine: 'Botella de vino', upgrade: 'Upgrade de villa', tour: 'Tour', consulta: 'Consulta al equipo'
};

async function solicitud(body, env) {
  const { code, tipo, detalle = {} } = body || {};
  if (!TIPOS[tipo] || !code) return json({ error: 'solicitud inválida' }, 400);
  const all = await bookings(env);
  const b = all.find(x => String(x.id) === String(code));
  if (!b) return json({ error: 'reserva no encontrada' }, 404);

  const filas = [
    ['Huésped', b.name], ['Villa', b.villa], ['Fechas', `${b.arrival} → ${b.departure}`], ['Huéspedes', b.guests],
    ['Reserva Lodgify', b.id], ['Canal', b.source], ['Correo', b.email], ['Teléfono', b.phone],
    ...Object.entries(detalle).map(([k, v]) => [k, v])
  ].filter(([, v]) => v !== '' && v != null);
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<h2 style="font-family:Georgia,serif">${esc(TIPOS[tipo])}</h2>
<table cellpadding="6" style="border-collapse:collapse;font-family:Georgia,serif">${filas.map(([k, v]) => `<tr><td style="color:#777;border-bottom:1px solid #ddd">${esc(k)}</td><td style="border-bottom:1px solid #ddd">${esc(v)}</td></tr>`).join('')}</table>
<p style="color:#777">Enviado desde la app de huéspedes de Canavida.</p>`;

  await env.DB.prepare('INSERT INTO solicitudes (reserva, tipo, detalle, fecha) VALUES (?, ?, ?, ?)')
    .bind(String(b.id), tipo, JSON.stringify(detalle), new Date().toISOString()).run();

  if (!env.RESEND_API_KEY) return json({ error: 'Falta el secreto RESEND_API_KEY en Cloudflare' }, 500);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY.trim(), 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Canavida App <onboarding@resend.dev>',
      to: [TEAM_EMAIL],
      reply_to: b.email || undefined,
      subject: `${TIPOS[tipo]} · ${b.name} · ${b.villa}`,
      html
    })
  });
  if (!r.ok) return json({ error: 'No se pudo enviar el correo (' + r.status + ')' }, 502);
  return json({ ok: true });
}

// ─── Asistente ──────────────────────────────────────────────────────────
let FAQ = null;
async function faq(env, url) {
  if (FAQ) return FAQ;
  const r = await env.ASSETS.fetch(new Request(new URL('/canavida-data.js', url)));
  const txt = await r.text();
  const data = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  FAQ = data.faq || [];
  return FAQ;
}

function relevantes(pregunta, lista) {
  const q = norm(pregunta);
  return lista
    .map(f => ({ f, s: (f.kw || []).reduce((n, k) => n + (q.includes(norm(k)) ? 1 : 0), 0) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3).map(x => x.f);
}

// ─── Traducción FR/DE de tours (Workers AI, guardada en D1 para siempre) ───
const IDIOMA = { es: 'español', en: 'inglés', fr: 'francés', de: 'alemán' };
const M2M = { fr: 'french', de: 'german' };

async function traducir({ lang, texts = [] }, env) {
  if (!M2M[lang] || !Array.isArray(texts)) return json({ error: 'idioma no soportado' }, 400);
  texts = texts.slice(0, 60).map(t => String(t).slice(0, 2000));
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS traducciones (lang TEXT, src TEXT, dst TEXT, PRIMARY KEY (lang, src))').run();
  const out = await Promise.all(texts.map(async src => {
    const row = await env.DB.prepare('SELECT dst FROM traducciones WHERE lang = ? AND src = ?').bind(lang, src).first();
    if (row) return row.dst;
    try {
      const r = await env.AI.run('@cf/meta/m2m100-1.2b', { text: src, source_lang: 'english', target_lang: M2M[lang] });
      const dst = (r.translated_text || '').trim();
      if (dst) await env.DB.prepare('INSERT OR REPLACE INTO traducciones (lang, src, dst) VALUES (?, ?, ?)').bind(lang, src, dst).run();
      return dst || src;
    } catch (e) { return src; }
  }));
  return json({ out });
}

async function chat({ reserva: r = {}, messages = [], lang = 'es' }, env, url) {
  const last = messages[messages.length - 1]?.content || '';
  const [lista, kb] = await Promise.all([
    faq(env, url),
    env.DB.prepare('SELECT pregunta, respuesta FROM knowledge ORDER BY id DESC LIMIT 40').all().then(x => x.results || [])
  ]);
  const top = relevantes(last, lista);
  const system = `Eres el asistente de Canavida Villas & Resort (Uvita, Costa Rica). Responde breve y cálido, SIEMPRE en ${IDIOMA[lang] || 'el idioma del huésped'}, sin emojis.
Huésped: ${r.first || ''} ${r.last || ''}. Villa: ${r.villa || ''}. Llegada: ${r.arrival || ''}. Salida: ${r.departure || ''}. Huéspedes: ${r.guests || ''}.
Check-in 3:00 p.m. Check-out 11:00 a.m.
Cómo llegar: 1) Tomar la entrada al frente a Mystic Sushi o la entrada a Invictus. 2) Recomendable 4x4, pero el camino está para todo tipo de vehículos. Waze: ${WAZE}
Nunca inventes precios ni disponibilidad. Para tours, extensiones o upgrades, invita a usar los botones de la app; el equipo confirma por correo.
Respuestas oficiales (úsalas tal cual cuando apliquen):
${top.map(f => `- ${f.title.es}: ${lang === 'es' ? f.a.es : f.a.en}`).join('\n')}
Conocimiento agregado por el equipo:
${kb.map(k => `- ${k.pregunta}: ${k.respuesta}`).join('\n')}
Si no sabes algo, dilo y responde exactamente con la palabra [EQUIPO] al final.`;
  const out = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [{ role: 'system', content: system }, ...messages.slice(-10)]
  });
  let reply = (out.response || '').trim();
  const handoff = reply.includes('[EQUIPO]');
  reply = reply.replace('[EQUIPO]', '').trim();
  await env.DB.prepare('INSERT INTO conversaciones (reserva, pregunta, respuesta, fecha) VALUES (?, ?, ?, ?)')
    .bind(r.code || '', last, reply, new Date().toISOString()).run();
  return json({ reply, handoff });
}
