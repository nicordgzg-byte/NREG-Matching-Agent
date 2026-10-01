import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.js';
import { createStore } from './db.js';
import { deterministicParse, formatRecord, parsePropertyMessage, scoreMatch } from './domain.js';
import { extractMessages, sendWhatsAppButtons, sendWhatsAppTemplate, sendWhatsAppText, verifySignature } from './whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const db = await createStore(config);

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function bodyText(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; if (body.length > 2_000_000) req.destroy(new Error('Payload too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function authorizedPhone(phone) {
  return config.adminPhoneNumbers.length === 0 || config.adminPhoneNumbers.includes(String(phone).replace(/^\+/, ''));
}

function panelAuthorized(req, url) {
  if (!config.adminPanelToken) return true;
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return header === config.adminPanelToken || url.searchParams.get('token') === config.adminPanelToken;
}

function recordPreview(record) {
  const missing = (record.missing_fields || []).filter((field) => field !== 'record_type');
  const suffix = missing.length ? `\n\nFalta confirmar: ${missing.join(', ')}.` : '';
  return `Detecté esta ficha:\n\n${formatRecord(record)}\n\nConfianza: ${Math.round((record.confidence || 0) * 100)}%${suffix}`;
}

async function processConfirmedRecord(from, record) {
  const saved = await db.insertRecord(record, from);
  await db.clearPending(from);
  await sendWhatsAppText(config.whatsapp, from, `Guardado durante 15 días.\n\n${formatRecord(saved)}`);

  const active = await db.getActiveRecords();
  const candidates = saved.record_type === 'OFFER'
    ? active.filter((item) => item.record_type === 'DEMAND')
    : active.filter((item) => item.record_type === 'OFFER');
  for (const candidate of candidates) {
    const offer = saved.record_type === 'OFFER' ? saved : candidate;
    const demand = saved.record_type === 'DEMAND' ? saved : candidate;
    const result = scoreMatch(offer, demand);
    if (!result) continue;
    const match = await db.insertOrUpdateMatch(offer.id, demand.id, result);
    if (match.isNew) {
      const alertText = `Match fuerte encontrado (${result.score}/100).\n\n${result.reasons.join(' · ')}\n\nOferta #${offer.id}: ${offer.original_message}\n\nDemanda #${demand.id}: ${demand.original_message}`;
      if (config.whatsapp.matchTemplateName) {
        await sendWhatsAppTemplate(config.whatsapp, from, config.whatsapp.matchTemplateName, config.whatsapp.matchTemplateLanguage, [String(result.score), String(offer.id), String(demand.id), result.reasons.join(', ')]);
      } else {
        await sendWhatsAppText(config.whatsapp, from, alertText);
      }
      await db.markMatchAlerted(match.id);
    }
  }
}

async function handleInboundMessage(message) {
  if (!message.id || !message.from || !authorizedPhone(message.from)) {
    if (message.from) await sendWhatsAppText(config.whatsapp, message.from, 'Este número no está autorizado para usar el agente NREG.');
    return;
  }
  if (!(await db.markMessageProcessed(message.id, message.from))) return;
  if (!message.text) {
    await sendWhatsAppText(config.whatsapp, message.from, 'Por ahora necesito texto. Reenvía el mensaje con una descripción de la oferta o demanda.');
    return;
  }

  const text = message.text.trim();
  const upper = text.toUpperCase();
  const pending = await db.getPending(message.from);

  if (upper === 'AYUDA') {
    await sendWhatsAppText(config.whatsapp, message.from, 'Reenvía un mensaje de oferta o demanda. Comandos: CONFIRMAR, CORREGIR, CANCELAR, CERRAR <id>, RENOVAR <id>.');
    return;
  }
  if (pending && (upper === 'CONFIRMAR' || upper === 'SI' || upper === 'SÍ')) {
    await processConfirmedRecord(message.from, pending.record);
    return;
  }
  if (pending && upper === 'CANCELAR') {
    await db.clearPending(message.from);
    await sendWhatsAppText(config.whatsapp, message.from, 'Cancelado. No guardé la oportunidad.');
    return;
  }
  if (pending && upper === 'CORREGIR') {
    await sendWhatsAppText(config.whatsapp, message.from, 'Escribe la corrección, por ejemplo: “precio máximo 8 mdp y 3 estacionamientos”.');
    return;
  }
  if (upper.startsWith('CERRAR ')) {
    const id = upper.replace('CERRAR ', '').trim();
    await db.updateRecordStatus(id, 'CLOSED');
    await sendWhatsAppText(config.whatsapp, message.from, `Registro #${id} cerrado.`);
    return;
  }
  if (upper.startsWith('RENOVAR ')) {
    const id = upper.replace('RENOVAR ', '').trim();
    await db.renewRecord(id);
    await sendWhatsAppText(config.whatsapp, message.from, `Registro #${id} renovado por 15 días.`);
    return;
  }

  const sourceText = pending && !['CONFIRMAR', 'CANCELAR', 'CORREGIR'].includes(upper)
    ? `${pending.original_message}. Corrección adicional: ${text}`
    : text;
  const parsed = await parsePropertyMessage(sourceText, config.openai);
  if (parsed.record_type === 'UNKNOWN') {
    await sendWhatsAppText(config.whatsapp, message.from, 'No pude identificar una oferta o demanda. Reenvía el mensaje o escribe BUSCO / OFREZCO con los datos de la propiedad.');
    return;
  }
  await db.setPending(message.from, parsed, sourceText);
  await sendWhatsAppButtons(config.whatsapp, message.from, recordPreview(parsed), [
    { id: 'CONFIRMAR', title: 'Confirmar' },
    { id: 'CORREGIR', title: 'Corregir' },
    { id: 'CANCELAR', title: 'Cancelar' }
  ]);
}

async function handleWebhook(req, res, rawBody) {
  if (!verifySignature(rawBody, req.headers['x-hub-signature-256'], config.whatsapp.appSecret)) return json(res, 401, { error: 'invalid signature' });
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return json(res, 400, { error: 'invalid json' }); }
  for (const message of extractMessages(payload)) {
    try { await handleInboundMessage(message); } catch (error) { console.error(error); }
  }
  return json(res, 200, { received: true });
}

function parseJsonBody(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return null; }
}

async function handleApi(req, res, url) {
  if (!panelAuthorized(req, url)) return json(res, 401, { error: 'unauthorized' });
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, time: new Date().toISOString() });
  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { panelProtected: Boolean(config.adminPanelToken), whatsappConfigured: Boolean(config.whatsapp.accessToken && config.whatsapp.phoneNumberId) });
  if (req.method === 'GET' && url.pathname === '/api/records') return json(res, 200, await db.getRecords(url.searchParams.get('status') || null));
  if (req.method === 'GET' && url.pathname === '/api/matches') return json(res, 200, await db.getMatches());
  const recordMatch = url.pathname.match(/^\/api\/records\/(\d+)\/(close|renew)$/);
  if (req.method === 'POST' && recordMatch) {
    if (recordMatch[2] === 'close') await db.updateRecordStatus(recordMatch[1], 'CLOSED');
    else await db.renewRecord(recordMatch[1]);
    return json(res, 200, { ok: true });
  }
  const match = url.pathname.match(/^\/api\/matches\/(\d+)\/review$/);
  if (req.method === 'POST' && match) {
    await db.markMatchReviewed(match[1]);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filename = path.resolve(publicDir, `.${requested}`);
  if (!filename.startsWith(path.resolve(publicDir))) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(filename)) return json(res, 404, { error: 'not found' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.writeHead(200, { 'content-type': types[path.extname(filename)] || 'application/octet-stream' });
  fs.createReadStream(filename).pipe(res);
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/webhooks/whatsapp') {
      if (url.searchParams.get('hub.verify_token') !== config.whatsapp.verifyToken) return json(res, 403, { error: 'invalid verify token' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(url.searchParams.get('hub.challenge') || '');
    }
    if (req.method === 'POST' && url.pathname === '/webhooks/whatsapp') return handleWebhook(req, res, await bodyText(req));
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: 'internal error' });
  }
}

const server = http.createServer(handleRequest);

setInterval(() => {
  db.getActiveRecords().catch((error) => console.error(error));
}, 60 * 60 * 1000).unref();

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  server.listen(config.port, () => {
    console.log(`NREG matcher listening at http://localhost:${config.port}`);
    console.log(`Storage: ${db.kind}`);
    if (!config.whatsapp.accessToken) console.log('WhatsApp is in dry-run mode until credentials are configured.');
    if (!config.openai.apiKey) console.log('AI extraction is using the deterministic fallback parser.');
  });
}

export { handleInboundMessage };
