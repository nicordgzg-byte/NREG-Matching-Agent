import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function mapRecord(row) {
  if (!row) return null;
  return {
    ...row,
    id: String(row.id),
    zones: row.zones ?? JSON.parse(row.zones_json || '[]'),
    features: row.features ?? JSON.parse(row.features_json || '[]')
  };
}

function sqliteStore(filename) {
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY, from_number TEXT NOT NULL, received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_records (
      from_number TEXT PRIMARY KEY, record_json TEXT NOT NULL, original_message TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_type TEXT NOT NULL CHECK(record_type IN ('OFFER','DEMAND')),
      operation TEXT, property_type TEXT, zones_json TEXT NOT NULL,
      price_min REAL, price_max REAL, currency TEXT NOT NULL,
      area_min_m2 REAL, area_max_m2 REAL, bedrooms_min REAL, bathrooms_min REAL, parking_min REAL,
      features_json TEXT NOT NULL, source_contact TEXT, source_group TEXT, original_message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE', confidence REAL NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, confirmed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER NOT NULL, demand_id INTEGER NOT NULL, score REAL NOT NULL,
      reasons_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'NEW', alerted_at TEXT, created_at TEXT NOT NULL,
      UNIQUE(offer_id, demand_id), FOREIGN KEY(offer_id) REFERENCES records(id), FOREIGN KEY(demand_id) REFERENCES records(id)
    );
  `);

  return {
    kind: 'sqlite',
    async insertRecord(record, fromNumber) {
      const now = new Date();
      const expires = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);
      const result = db.prepare(`
        INSERT INTO records (
          record_type, operation, property_type, zones_json, price_min, price_max, currency,
          area_min_m2, area_max_m2, bedrooms_min, bathrooms_min, parking_min, features_json,
          source_contact, source_group, original_message, status, confidence, created_at, expires_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
      `).run(record.record_type, record.operation || null, record.property_type || null,
        JSON.stringify(record.zones || []), record.price_min ?? null, record.price_max ?? null,
        record.currency || 'MXN', record.area_min_m2 ?? null, record.area_max_m2 ?? null,
        record.bedrooms_min ?? null, record.bathrooms_min ?? null, record.parking_min ?? null,
        JSON.stringify(record.features || []), record.source_contact || fromNumber || null,
        record.source_group || null, record.original_message, Number(record.confidence || 0),
        now.toISOString(), expires.toISOString(), now.toISOString());
      return mapRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(Number(result.lastInsertRowid)));
    },
    async expireRecords() {
      db.prepare("UPDATE records SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= ?").run(new Date().toISOString());
    },
    async getActiveRecords() {
      await this.expireRecords();
      return db.prepare("SELECT * FROM records WHERE status = 'ACTIVE' ORDER BY created_at DESC").all().map(mapRecord);
    },
    async getRecords(status) {
      await this.expireRecords();
      const rows = status ? db.prepare('SELECT * FROM records WHERE status = ? ORDER BY created_at DESC').all(status) : db.prepare('SELECT * FROM records ORDER BY created_at DESC').all();
      return rows.map(mapRecord);
    },
    async getMatches() {
      return db.prepare(`
        SELECT m.*, o.original_message AS offer_message, d.original_message AS demand_message,
          o.zones_json AS offer_zones_json, d.zones_json AS demand_zones_json
        FROM matches m JOIN records o ON o.id = m.offer_id JOIN records d ON d.id = m.demand_id
        ORDER BY m.created_at DESC
      `).all().map((row) => ({ ...row, id: String(row.id), offer_id: String(row.offer_id), demand_id: String(row.demand_id), reasons: JSON.parse(row.reasons_json || '[]') }));
    },
    async markMessageProcessed(messageId, fromNumber) {
      try { db.prepare('INSERT INTO processed_messages (message_id, from_number, received_at) VALUES (?, ?, ?)').run(messageId, fromNumber, new Date().toISOString()); return true; }
      catch (error) { if (String(error.message).includes('UNIQUE')) return false; throw error; }
    },
    async setPending(fromNumber, record, originalMessage) {
      db.prepare(`INSERT INTO pending_records (from_number, record_json, original_message, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(from_number) DO UPDATE SET record_json = excluded.record_json, original_message = excluded.original_message, created_at = excluded.created_at`)
        .run(fromNumber, JSON.stringify(record), originalMessage, new Date().toISOString());
    },
    async getPending(fromNumber) {
      const row = db.prepare('SELECT * FROM pending_records WHERE from_number = ?').get(fromNumber);
      return row ? { ...row, record: JSON.parse(row.record_json) } : null;
    },
    async clearPending(fromNumber) { db.prepare('DELETE FROM pending_records WHERE from_number = ?').run(fromNumber); },
    async insertOrUpdateMatch(offerId, demandId, result) {
      const now = new Date().toISOString();
      const existing = db.prepare('SELECT * FROM matches WHERE offer_id = ? AND demand_id = ?').get(Number(offerId), Number(demandId));
      if (existing) {
        db.prepare('UPDATE matches SET score = ?, reasons_json = ?, created_at = ? WHERE id = ?').run(result.score, JSON.stringify(result.reasons), now, existing.id);
        return { id: String(existing.id), offer_id: String(offerId), demand_id: String(demandId), score: result.score, reasons: result.reasons, isNew: false };
      }
      const inserted = db.prepare("INSERT INTO matches (offer_id, demand_id, score, reasons_json, status, created_at) VALUES (?, ?, ?, ?, 'NEW', ?)").run(Number(offerId), Number(demandId), result.score, JSON.stringify(result.reasons), now);
      return { id: String(inserted.lastInsertRowid), offer_id: String(offerId), demand_id: String(demandId), score: result.score, reasons: result.reasons, isNew: true };
    },
    async updateRecordStatus(id, status) { db.prepare('UPDATE records SET status = ? WHERE id = ?').run(status, Number(id)); },
    async renewRecord(id) { db.prepare("UPDATE records SET status = 'ACTIVE', expires_at = ? WHERE id = ?").run(new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(), Number(id)); },
    async markMatchReviewed(id, status = 'REVIEWED') { db.prepare('UPDATE matches SET status = ? WHERE id = ?').run(status, Number(id)); },
    async markMatchAlerted(id) { db.prepare("UPDATE matches SET alerted_at = ?, status = 'ALERTED' WHERE id = ?").run(new Date().toISOString(), Number(id)); }
  };
}

async function supabaseStore(url, key) {
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const fail = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  const selectRecords = (query) => query.then(fail).then((rows) => (rows || []).map(mapRecord));

  return {
    kind: 'supabase',
    async insertRecord(record, fromNumber) {
      const now = new Date();
      const expires = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);
      const row = {
        record_type: record.record_type, operation: record.operation || null, property_type: record.property_type || null,
        zones: record.zones || [], price_min: record.price_min ?? null, price_max: record.price_max ?? null, currency: record.currency || 'MXN',
        area_min_m2: record.area_min_m2 ?? null, area_max_m2: record.area_max_m2 ?? null, bedrooms_min: record.bedrooms_min ?? null,
        bathrooms_min: record.bathrooms_min ?? null, parking_min: record.parking_min ?? null, features: record.features || [],
        source_contact: record.source_contact || fromNumber || null, source_group: record.source_group || null, original_message: record.original_message,
        status: 'ACTIVE', confidence: Number(record.confidence || 0), created_at: now.toISOString(), expires_at: expires.toISOString(), confirmed_at: now.toISOString()
      };
      const { data, error } = await client.from('records').insert(row).select().single();
      if (error) throw new Error(error.message);
      return mapRecord(data);
    },
    async expireRecords() {
      const { error } = await client.from('records').update({ status: 'EXPIRED' }).eq('status', 'ACTIVE').lte('expires_at', new Date().toISOString());
      if (error) throw new Error(error.message);
    },
    async getActiveRecords() {
      await this.expireRecords();
      return selectRecords(client.from('records').select('*').eq('status', 'ACTIVE').order('created_at', { ascending: false }));
    },
    async getRecords(status) {
      await this.expireRecords();
      let query = client.from('records').select('*').order('created_at', { ascending: false });
      if (status) query = query.eq('status', status);
      return selectRecords(query);
    },
    async getMatches() {
      const matches = fail(await client.from('matches').select('*').order('created_at', { ascending: false }));
      const recordIds = [...new Set((matches || []).flatMap((row) => [row.offer_id, row.demand_id]))];
      const records = recordIds.length ? fail(await client.from('records').select('*').in('id', recordIds)) : [];
      const byId = new Map(records.map((record) => [String(record.id), record]));
      return (matches || []).map((row) => ({ ...row, id: String(row.id), offer_id: String(row.offer_id), demand_id: String(row.demand_id), reasons: row.reasons || [], offer_message: byId.get(String(row.offer_id))?.original_message || '', demand_message: byId.get(String(row.demand_id))?.original_message || '' }));
    },
    async markMessageProcessed(messageId, fromNumber) {
      const { error } = await client.from('processed_messages').insert({ message_id: messageId, from_number: fromNumber, received_at: new Date().toISOString() });
      if (!error) return true;
      if (error.code === '23505') return false;
      throw new Error(error.message);
    },
    async setPending(fromNumber, record, originalMessage) {
      const { error } = await client.from('pending_records').upsert({ from_number: fromNumber, record_json: record, original_message: originalMessage, created_at: new Date().toISOString() });
      if (error) throw new Error(error.message);
    },
    async getPending(fromNumber) {
      const { data, error } = await client.from('pending_records').select('*').eq('from_number', fromNumber).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? { ...data, record: data.record_json } : null;
    },
    async clearPending(fromNumber) { const { error } = await client.from('pending_records').delete().eq('from_number', fromNumber); if (error) throw new Error(error.message); },
    async insertOrUpdateMatch(offerId, demandId, result) {
      const existing = fail(await client.from('matches').select('*').eq('offer_id', Number(offerId)).eq('demand_id', Number(demandId)).maybeSingle());
      if (existing) {
        const { error } = await client.from('matches').update({ score: result.score, reasons: result.reasons, created_at: new Date().toISOString() }).eq('id', existing.id);
        if (error) throw new Error(error.message);
        return { id: String(existing.id), offer_id: String(offerId), demand_id: String(demandId), score: result.score, reasons: result.reasons, isNew: false };
      }
      const { data, error } = await client.from('matches').insert({ offer_id: Number(offerId), demand_id: Number(demandId), score: result.score, reasons: result.reasons, status: 'NEW', created_at: new Date().toISOString() }).select().single();
      if (error) throw new Error(error.message);
      return { id: String(data.id), offer_id: String(offerId), demand_id: String(demandId), score: result.score, reasons: result.reasons, isNew: true };
    },
    async updateRecordStatus(id, status) { const { error } = await client.from('records').update({ status }).eq('id', Number(id)); if (error) throw new Error(error.message); },
    async renewRecord(id) { const { error } = await client.from('records').update({ status: 'ACTIVE', expires_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString() }).eq('id', Number(id)); if (error) throw new Error(error.message); },
    async markMatchReviewed(id, status = 'REVIEWED') { const { error } = await client.from('matches').update({ status }).eq('id', Number(id)); if (error) throw new Error(error.message); },
    async markMatchAlerted(id) { const { error } = await client.from('matches').update({ alerted_at: new Date().toISOString(), status: 'ALERTED' }).eq('id', Number(id)); if (error) throw new Error(error.message); }
  };
}

export async function createStore(config) {
  if (config.supabaseUrl && config.supabaseServerKey) return supabaseStore(config.supabaseUrl, config.supabaseServerKey);
  return sqliteStore(config.databaseFile);
}
