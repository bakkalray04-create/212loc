/**
 * ============================================================================
 * PARCAUTO MAROC — SERVEUR BACK-END OFFICIEL (server.js)
 * ============================================================================
 * Optimisé pour déploiement sur Railway + PostgreSQL (et exécution locale) :
 * 1. CONNEXION POSTGRESQL STRICTE EN PRODUCTION :
 *    - Si `DATABASE_URL` est défini (Railway / Render / Supabase / Neon),
 *      se connecte avec reconnexion automatique (jusqu'à 5 tentatives au démarrage)
 *      et initialise toutes les tables SQL de `database.sql`.
 *    - En production (`DATABASE_URL` défini), n'utilise PAS le fichier JSON local
 *      en cas d'erreur SQL afin de garantir qu'aucune donnée d'agence n'est perdue
 *      dans un conteneur éphémère (sauf si `ALLOW_LOCAL_FALLBACK=true`).
 * 2. SYNCHRONISATION RELATIONNELLE COMPLÈTE (ZÉRO DONNÉE DE DÉMO) :
 *    - Stocke et restitue l'intégralité des colonnes de l'agence (`company`, `owner_name`,
 *      `legal_name`, `ice`, `rc`, `city`, `address`, `phone`, `email`, `plan`, `period`,
 *      `trial_days`, `tva`, `rules_json`) ainsi que les 6 tables métier dans PostgreSQL.
 *    - Gère les ajouts, modifications ET suppressions d'enregistrements en transaction SQL.
 * 3. ISOLATION MULTI-AGENCES PAR JWT SIGNÉ :
 *    - Chaque requête `/rest/v1/*` exige un JWT valide et filtre exclusivement
 *      par `agency_id = verified.sub`.
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'parcauto_db.json');
const SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) {
    return process.env.JWT_SECRET;
  }
  try {
    if (fs.existsSync(SECRET_FILE)) {
      return fs.readFileSync(SECRET_FILE, 'utf8').trim();
    }
    const generated = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(SECRET_FILE, generated, { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch (e) {
    return crypto.createHash('sha256').update(__dirname + '-parcauto-secret').digest('hex');
  }
}
const JWT_SECRET = getJwtSecret();
const ADMIN_KEY = process.env.ADMIN_API_KEY || 'ADMIN2026';

// ============================================================================
// 1. COUCHE BASE DE DONNÉES : POSTGRESQL (`DATABASE_URL`) AVEC RETRY AU DÉMARRAGE
// ============================================================================

let pgPool = null;
let dbLastError = null;

async function initPostgresIfConfigured() {
  if (!process.env.DATABASE_URL) {
    console.log('[ParcAuto DB] Aucun DATABASE_URL détecté — utilisation du stockage local (data/parcauto_db.json).');
    return false;
  }
  const { Pool } = require('pg');
  const isLocalHost = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  const useSsl = process.env.PGSSLMODE === 'disable' || isLocalHost ? false : { rejectUnauthorized: false };

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const candidatePool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: useSsl,
        max: 15,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
      });
      await candidatePool.query('SELECT 1');
      const sqlPath = path.join(__dirname, 'database.sql');
      if (fs.existsSync(sqlPath)) {
        const schemaSql = fs.readFileSync(sqlPath, 'utf8');
        await candidatePool.query(schemaSql);
      }
      pgPool = candidatePool;
      dbLastError = null;
      console.log(`[ParcAuto DB] Connecté à PostgreSQL avec succès (tentative ${attempt}/5).`);
      return true;
    } catch (err) {
      dbLastError = err.message;
      console.error(`[ParcAuto DB] Échec connexion PostgreSQL (tentative ${attempt}/5) :`, err.message);
      if (attempt < 5) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  if (process.env.ALLOW_LOCAL_FALLBACK !== 'true') {
    console.error('[ParcAuto DB] ERREUR CRITIQUE : DATABASE_URL est configuré mais PostgreSQL est injoignable.');
    // On conserve pgPool = null mais les routes renverront 503 tant que PostgreSQL n'est pas rétabli
  }
  return false;
}

function ensureDbAvailable(res) {
  if (process.env.DATABASE_URL && !pgPool && process.env.ALLOW_LOCAL_FALLBACK !== 'true') {
    sendJson(res, 503, {
      error: 'Base de données PostgreSQL temporairement indisponible. Réessayez dans quelques secondes.',
      details: dbLastError
    });
    return false;
  }
  return true;
}

const localDb = {
  users: [],
  agencies: {},
  vehicles: {},
  vehicle_documents: {},
  clients: {},
  rentals: {},
  maintenances: {},
  claims: {},
  leads: []
};

function loadLocalDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      Object.assign(localDb, parsed);
    }
  } catch (err) {
    console.error('[ParcAuto DB] Erreur lecture locale :', err.message);
  }
}

function saveLocalDb() {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(localDb, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[ParcAuto DB] Erreur écriture locale :', err.message);
  }
}
loadLocalDb();

// Adaptateur unifié de base de données (PostgreSQL prioritaire, JSON local en développement)
const Store = {
  async findUserByEmail(email) {
    if (pgPool) {
      const { rows } = await pgPool.query(
        'SELECT id, email, password_hash, created_at FROM public.app_users WHERE email = $1 LIMIT 1',
        [email]
      );
      return rows[0] || null;
    }
    return localDb.users.find(u => u.email === email) || null;
  },

  async createUser(email, passwordHash, meta = {}) {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const days = Number.isFinite(+meta.trial_days) ? +meta.trial_days : 14;
    const endsAt = new Date(Date.now() + days * 86400000).toISOString();
    const company = String(meta.company || 'Mon Agence Auto').slice(0, 150);
    const ownerName = String(meta.owner_name || meta.user || 'Gérant').slice(0, 120);
    const city = String(meta.city || 'Casablanca').slice(0, 80);
    const phone = String(meta.phone || '').slice(0, 50);
    const legalName = String(meta.legal_name || (company + ' SARL')).slice(0, 150);
    const plan = ['essentiel', 'pro', 'business', 'surmesure'].includes(meta.plan) ? meta.plan : 'pro';

    // Une nouvelle agence démarre toujours avec un parc vierge (aucune donnée fictive de démo)
    const emptySnapshot = { V: [], DOCS: [], C: [], R: [], M: [], SIN: [] };

    if (pgPool) {
      const { rows } = await pgPool.query(
        'INSERT INTO public.app_users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id, email, created_at',
        [id, email, passwordHash, createdAt]
      );
      await pgPool.query(
        `INSERT INTO public.agencies (id, owner_id, email, company, owner_name, legal_name, city, address, phone, plan, trial_days, subscription_ends_at, state_snapshot)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING`,
        [id, email, company, ownerName, legalName, city, city, phone, plan, days, endsAt, JSON.stringify(emptySnapshot)]
      );
      return rows[0];
    }
    const user = { id, email, password_hash: passwordHash, created_at: createdAt };
    localDb.users.push(user);
    if (!localDb.agencies[id]) {
      localDb.agencies[id] = {
        id, owner_id: id, email, company, owner_name: ownerName, legal_name: legalName,
        ice: '', rc: '', city, address: city, phone, plan,
        period: 'month', trial_days: days, tva: 20, subscription_ends_at: endsAt,
        suspended: false, state_snapshot: emptySnapshot, created_at: createdAt
      };
      localDb.vehicles[id] = [];
      localDb.vehicle_documents[id] = [];
      localDb.clients[id] = [];
      localDb.rentals[id] = [];
      localDb.maintenances[id] = [];
      localDb.claims[id] = [];
    }
    saveLocalDb();
    return user;
  },

  async getAgency(agencyId) {
    if (pgPool) {
      const { rows } = await pgPool.query('SELECT * FROM public.agencies WHERE id = $1 LIMIT 1', [agencyId]);
      if (rows[0] && rows[0].subscription_ends_at) {
        rows[0].trial_days = Math.max(0, Math.ceil((new Date(rows[0].subscription_ends_at).getTime() - Date.now()) / 86400000));
      }
      return rows;
    }
    const ag = localDb.agencies[agencyId];
    if (ag && ag.subscription_ends_at) {
      ag.trial_days = Math.max(0, Math.ceil((new Date(ag.subscription_ends_at).getTime() - Date.now()) / 86400000));
    }
    return ag ? [ag] : [];
  },

  async upsertAgency(agencyId, data) {
    const existing = (await this.getAgency(agencyId))[0] || {};
    const payload = {
      id: agencyId,
      owner_id: agencyId,
      company: String(data.company ?? existing.company ?? 'Mon Agence Auto').slice(0, 150),
      owner_name: String(data.owner_name ?? data.user ?? existing.owner_name ?? 'Gérant').slice(0, 120),
      legal_name: String(data.legal_name ?? existing.legal_name ?? '').slice(0, 150),
      ice: String(data.ice ?? existing.ice ?? '').slice(0, 50),
      rc: String(data.rc ?? existing.rc ?? '').slice(0, 80),
      city: String(data.city ?? existing.city ?? 'Casablanca').slice(0, 80),
      address: String(data.address ?? existing.address ?? '').slice(0, 250),
      phone: String(data.phone ?? existing.phone ?? '').slice(0, 50),
      email: String(data.email ?? existing.email ?? '').slice(0, 120),
      plan: ['essentiel', 'pro', 'business', 'surmesure'].includes(data.plan) ? data.plan : (existing.plan || 'pro'),
      period: data.period === 'year' ? 'year' : (existing.period || 'month'),
      trial_days: Number.isFinite(+data.trial_days) ? +data.trial_days : (existing.trial_days ?? 14),
      tva: Number.isFinite(+data.tva) ? +data.tva : (existing.tva ?? 20),
      rules_json: data.rules_json ?? existing.rules_json ?? null,
      state_snapshot: data.state_snapshot ?? existing.state_snapshot ?? null,
      updated_at: new Date().toISOString()
    };
    if (pgPool) {
      await pgPool.query(
        `INSERT INTO public.agencies (
           id, owner_id, company, owner_name, legal_name, ice, rc, city, address, phone, email,
           plan, period, trial_days, tva, rules_json, state_snapshot, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO UPDATE SET
           company = EXCLUDED.company,
           owner_name = EXCLUDED.owner_name,
           legal_name = EXCLUDED.legal_name,
           ice = EXCLUDED.ice,
           rc = EXCLUDED.rc,
           city = EXCLUDED.city,
           address = EXCLUDED.address,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           plan = EXCLUDED.plan,
           period = EXCLUDED.period,
           trial_days = EXCLUDED.trial_days,
           tva = EXCLUDED.tva,
           rules_json = EXCLUDED.rules_json,
           state_snapshot = EXCLUDED.state_snapshot,
           updated_at = EXCLUDED.updated_at`,
        [
          payload.id, payload.owner_id, payload.company, payload.owner_name, payload.legal_name,
          payload.ice, payload.rc, payload.city, payload.address, payload.phone, payload.email,
          payload.plan, payload.period, payload.trial_days, payload.tva,
          payload.rules_json ? JSON.stringify(payload.rules_json) : null,
          payload.state_snapshot ? JSON.stringify(payload.state_snapshot) : null,
          payload.updated_at
        ]
      );
      return await this.getAgency(agencyId);
    }
    localDb.agencies[agencyId] = { ...existing, ...payload };
    saveLocalDb();
    return [localDb.agencies[agencyId]];
  },

  async getTable(table, agencyId) {
    if (pgPool) {
      const { rows } = await pgPool.query(
        `SELECT * FROM public.${table} WHERE agency_id = $1 ORDER BY created_at ASC`,
        [agencyId]
      );
      return rows;
    }
    return localDb[table][agencyId] || [];
  },

  // Synchronisation transactionnelle complète (Upsert + Suppression des lignes retirées quand replaceAll=true)
  async upsertTable(table, agencyId, items, replaceAll = false) {
    const rawList = Array.isArray(items) ? items : [items];
    const rows = rawList.filter(r => r && r.id);
    const sanitized = rows.map(r => ({ ...r, id: String(r.id).slice(0, 64), agency_id: agencyId }));
    const keepIds = sanitized.map(r => r.id);

    if (pgPool) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        if (replaceAll) {
          if (keepIds.length === 0) {
            await client.query(`DELETE FROM public.${table} WHERE agency_id = $1`, [agencyId]);
          } else {
            await client.query(
              `DELETE FROM public.${table} WHERE agency_id = $1 AND NOT (id = ANY($2::text[]))`,
              [agencyId, keepIds]
            );
          }
        }
        for (const r of sanitized) {
          if (table === 'vehicles') {
            await client.query(
              `INSERT INTO public.vehicles (id, agency_id, plate, brand, model, year, color, fuel, box, vin, km, buy_date, buy_price, supplier, warranty_end, daily_rate, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
               ON CONFLICT (agency_id, id) DO UPDATE SET
                 plate=EXCLUDED.plate, brand=EXCLUDED.brand, model=EXCLUDED.model, year=EXCLUDED.year, color=EXCLUDED.color,
                 fuel=EXCLUDED.fuel, box=EXCLUDED.box, vin=EXCLUDED.vin, km=EXCLUDED.km, buy_date=EXCLUDED.buy_date,
                 buy_price=EXCLUDED.buy_price, supplier=EXCLUDED.supplier, warranty_end=EXCLUDED.warranty_end,
                 daily_rate=EXCLUDED.daily_rate, status=EXCLUDED.status`,
              [r.id, agencyId, r.plate || '', r.brand || '', r.model || '', +r.year || 2026, r.color || '',
               r.fuel || 'Diesel', r.box || 'Manuelle', r.vin || '', +r.km || 0, r.buy_date || r.buy || null,
               +(r.buy_price ?? r.price ?? 0), r.supplier || '', r.warranty_end || r.warranty || null,
               +(r.daily_rate ?? r.daily ?? 250), r.status || 'available']
            );
          } else if (table === 'vehicle_documents') {
            await client.query(
              `INSERT INTO public.vehicle_documents (id, agency_id, vid, kind, due_date, org, cost)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (agency_id, id) DO UPDATE SET vid=EXCLUDED.vid, kind=EXCLUDED.kind, due_date=EXCLUDED.due_date, org=EXCLUDED.org, cost=EXCLUDED.cost`,
              [r.id, agencyId, r.vid, r.kind || 'insurance', r.due_date || r.due, r.org || '', +r.cost || 0]
            );
          } else if (table === 'clients') {
            await client.query(
              `INSERT INTO public.clients (id, agency_id, name, phone, cin, licence, email, since_date)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (agency_id, id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, cin=EXCLUDED.cin, licence=EXCLUDED.licence, email=EXCLUDED.email, since_date=EXCLUDED.since_date`,
              [r.id, agencyId, r.name || '', r.phone || '', r.cin || '', r.licence || r.lic || '', r.email || r.mail || '', r.since_date || r.since || null]
            );
          } else if (table === 'rentals') {
            await client.query(
              `INSERT INTO public.rentals (id, agency_id, vid, cid, date_from, date_to, daily_rate, deposit, km_out, km_in, place)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT (agency_id, id) DO UPDATE SET vid=EXCLUDED.vid, cid=EXCLUDED.cid, date_from=EXCLUDED.date_from, date_to=EXCLUDED.date_to, daily_rate=EXCLUDED.daily_rate, deposit=EXCLUDED.deposit, km_out=EXCLUDED.km_out, km_in=EXCLUDED.km_in, place=EXCLUDED.place`,
              [r.id, agencyId, r.vid, r.cid, r.date_from || r.from, r.date_to || r.to, +(r.daily_rate ?? r.daily ?? 250), +(r.deposit ?? r.dep ?? 3000), +(r.km_out ?? r.kmOut ?? 0), (r.km_in ?? r.kmIn) != null ? +(r.km_in ?? r.kmIn) : null, r.place || 'Agence Casablanca']
            );
          } else if (table === 'maintenances') {
            await client.query(
              `INSERT INTO public.maintenances (id, agency_id, vid, maint_date, type, description, cost, garage, km, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (agency_id, id) DO UPDATE SET vid=EXCLUDED.vid, maint_date=EXCLUDED.maint_date, type=EXCLUDED.type, status=EXCLUDED.status, cost=EXCLUDED.cost, description=EXCLUDED.description, garage=EXCLUDED.garage, km=EXCLUDED.km`,
              [r.id, agencyId, r.vid, r.maint_date || r.date, r.type || 'Entretien', r.description ?? r.desc ?? '', +r.cost || 0, r.garage || '', +r.km || 0, r.status || 'open']
            );
          } else if (table === 'claims') {
            await client.query(
              `INSERT INTO public.claims (id, agency_id, vid, claim_date, ref, driver, place, responsibility, damage, amount, insurer, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
               ON CONFLICT (agency_id, id) DO UPDATE SET vid=EXCLUDED.vid, claim_date=EXCLUDED.claim_date, ref=EXCLUDED.ref, driver=EXCLUDED.driver, place=EXCLUDED.place, responsibility=EXCLUDED.responsibility, damage=EXCLUDED.damage, status=EXCLUDED.status, amount=EXCLUDED.amount, insurer=EXCLUDED.insurer`,
              [r.id, agencyId, r.vid, r.claim_date || r.date, r.ref || '', r.driver || '', r.place || '', r.responsibility || r.resp || 'Tiers', r.damage || r.dmg || '', +r.amount || 0, r.insurer || '', r.status || 'open']
            );
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return sanitized.length;
    }

    if (replaceAll) {
      localDb[table][agencyId] = sanitized;
    } else {
      if (!localDb[table][agencyId]) localDb[table][agencyId] = [];
      const list = localDb[table][agencyId];
      for (const row of sanitized) {
        const idx = list.findIndex(x => x.id === row.id);
        if (idx >= 0) list[idx] = { ...list[idx], ...row };
        else list.push(row);
      }
    }
    saveLocalDb();
    return sanitized.length;
  },

  async createLead(lead) {
    const item = {
      id: crypto.randomUUID(),
      agency_name: String(lead.agency_name || '').slice(0, 120),
      city: String(lead.city || '').slice(0, 80),
      phone: String(lead.phone || '').slice(0, 40),
      fleet_size: String(lead.fleet_size || '').slice(0, 60),
      message: String(lead.message || '').slice(0, 1000),
      created_at: new Date().toISOString()
    };
    if (pgPool) {
      await pgPool.query(
        'INSERT INTO public.leads (id, agency_name, city, phone, fleet_size, message, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [item.id, item.agency_name, item.city, item.phone, item.fleet_size, item.message, item.created_at]
      );
      return item;
    }
    localDb.leads.unshift(item);
    saveLocalDb();
    return item;
  },

  async listAllAgencies() {
    if (pgPool) {
      await pgPool.query('SELECT public.check_expired_agencies()').catch(() => {});
      const { rows } = await pgPool.query(
        `SELECT a.id, a.company, a.owner_name, a.city, a.phone, a.email, a.plan, a.period,
                a.trial_days, a.subscription_ends_at, a.suspended, a.created_at,
                (SELECT count(*)::int FROM public.vehicles v WHERE v.agency_id = a.id) AS vehicles_count
         FROM public.agencies a
         ORDER BY a.created_at DESC`
      );
      return rows.map(r => ({
        ...r,
        trial_days: r.subscription_ends_at
          ? Math.max(0, Math.ceil((new Date(r.subscription_ends_at).getTime() - Date.now()) / 86400000))
          : r.trial_days
      }));
    }
    let changed = false;
    const list = Object.values(localDb.agencies).map(a => {
      if (a.subscription_ends_at) {
        const rem = Math.max(0, Math.ceil((new Date(a.subscription_ends_at).getTime() - Date.now()) / 86400000));
        a.trial_days = rem;
        if (rem === 0 && !a.suspended && a.auto_suspend !== false) {
          a.suspended = true;
          changed = true;
        }
      }
      return {
        id: a.id,
        company: a.company || 'Agence',
        owner_name: a.owner_name || 'Gérant',
        city: a.city || 'Casablanca',
        phone: a.phone || '',
        email: a.email || '',
        plan: a.plan || 'pro',
        period: a.period || 'month',
        trial_days: a.trial_days ?? 14,
        subscription_ends_at: a.subscription_ends_at || null,
        suspended: !!a.suspended,
        vehicles_count: (localDb.vehicles[a.id] || []).length,
        created_at: a.created_at || new Date().toISOString()
      };
    });
    if (changed) saveLocalDb();
    return list;
  },

  async listAllLeads() {
    if (pgPool) {
      const { rows } = await pgPool.query('SELECT * FROM public.leads ORDER BY created_at DESC LIMIT 200');
      return rows;
    }
    return localDb.leads;
  },

  async updateAgencyStatus(agencyId, patch) {
    if (pgPool) {
      const ag = (await this.getAgency(agencyId))[0];
      if (!ag) return null;
      const newPlan = patch.plan || ag.plan || 'pro';
      let newTrial = patch.trial_days != null ? +patch.trial_days : (ag.trial_days ?? 14);
      const newSusp = patch.suspended != null ? !!patch.suspended : !!ag.suspended;
      if (!newSusp && newTrial <= 0) newTrial = 30;
      const newEndsAt = patch.trial_days != null || (!newSusp && ag.suspended)
        ? new Date(Date.now() + Math.max(0, newTrial) * 86400000).toISOString()
        : (ag.subscription_ends_at || new Date(Date.now() + newTrial * 86400000).toISOString());

      await pgPool.query(
        'UPDATE public.agencies SET plan = $1, trial_days = $2, subscription_ends_at = $3, suspended = $4, updated_at = now() WHERE id = $5',
        [newPlan, Math.max(0, newTrial), newEndsAt, newSusp, agencyId]
      );
      return (await this.getAgency(agencyId))[0];
    }
    const ag = localDb.agencies[agencyId];
    if (!ag) return null;
    if (patch.plan) ag.plan = patch.plan;
    if (patch.trial_days != null) {
      ag.trial_days = +patch.trial_days;
      ag.subscription_ends_at = new Date(Date.now() + (+patch.trial_days) * 86400000).toISOString();
    }
    if (patch.suspended != null) {
      ag.suspended = !!patch.suspended;
      if (!ag.suspended && ag.trial_days === 0) {
        ag.trial_days = 30;
        ag.subscription_ends_at = new Date(Date.now() + 30 * 86400000).toISOString();
      }
    }
    saveLocalDb();
    return ag;
  }
};

// ============================================================================
// 2. SÉCURITÉ : SCRYPT, JWT SIGNÉ & AUTHENTIFICATION OBLIGATOIRE
// ============================================================================

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const hashBuffer = crypto.scryptSync(String(password), salt, 64);
  const keyBuffer = Buffer.from(key, 'hex');
  if (hashBuffer.length !== keyBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, keyBuffer);
}

function signJwt(payload, expiresInSec = 86400 * 7) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expiresInSec;
  const body = Buffer.from(JSON.stringify({ ...payload, iat, exp })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const raw = token.replace(/^Bearer\s+/i, '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.sub || (payload.exp && payload.exp < Math.floor(Date.now() / 1000))) {
      return null;
    }
    return payload;
  } catch (e) {
    return null;
  }
}

function requireAuthAgency(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const verified = verifyJwt(authHeader);
  if (!verified || !verified.sub) {
    sendJson(res, 401, { error: 'Non autorisé : jeton de session agence manquant ou invalide.' });
    return null;
  }
  return verified.sub;
}

// ============================================================================
// 3. PARE-FEU : RATE LIMITING PAR IP & PROTECTION BRUTE-FORCE
// ============================================================================

const rateBuckets = new Map();
function checkRateLimit(key, maxReq = 120, windowMs = 60000) {
  const now = Date.now();
  const entry = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  rateBuckets.set(key, entry);
  return entry.count <= maxReq;
}

function setSecurityHeaders(req, res) {
  const origin = req.headers['origin'] || '*';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, Prefer, x-admin-key, x-webhook-secret');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('Payload trop volumineux'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

// ============================================================================
// 4. ROUTEUR HTTP PRINCIPAL
// ============================================================================

const TABLES = ['vehicles', 'vehicle_documents', 'clients', 'rentals', 'maintenances', 'claims'];

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const ip = req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit('ip:' + ip, 180, 60000)) {
    return sendJson(res, 429, { error: 'Trop de requêtes, veuillez patienter.' });
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  try {
    // --- A. SANTÉ DU SERVEUR ---
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        status: 'ok',
        service: 'ParcAuto Maroc Back-End',
        engine: pgPool ? 'postgresql' : 'local-transactional-json',
        database_connected: !!pgPool || !process.env.DATABASE_URL,
        timestamp: new Date().toISOString()
      });
    }

    // --- B. INSCRIPTION AGENCE (/auth/v1/signup) ---
    if (pathname === '/auth/v1/signup' && req.method === 'POST') {
      if (!ensureDbAvailable(res)) return;
      if (!checkRateLimit('auth:' + ip, 20, 15 * 60000)) {
        return sendJson(res, 429, { msg: 'Trop de tentatives. Réessayez dans 15 minutes.' });
      }
      const { email, password, company, owner_name, user: userName, city, phone, plan } = await readJsonBody(req);
      const cleanEmail = String(email || '').trim().toLowerCase();
      if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return sendJson(res, 400, { msg: 'Adresse email professionnelle invalide.' });
      }
      if (!password || String(password).length < 6) {
        return sendJson(res, 400, { msg: 'Le mot de passe doit contenir au moins 6 caractères.' });
      }
      const existing = await Store.findUserByEmail(cleanEmail);
      if (existing) {
        return sendJson(res, 400, { msg: 'Un compte existe déjà avec cet email. Connectez-vous.' });
      }
      const user = await Store.createUser(cleanEmail, hashPassword(password), {
        company,
        owner_name: owner_name || userName || 'Gérant',
        city,
        phone,
        plan,
        trial_days: 14
      });
      const agencyRows = await Store.getAgency(user.id);
      const token = signJwt({ sub: user.id, email: user.email });
      return sendJson(res, 200, {
        access_token: token,
        token_type: 'bearer',
        user: { id: user.id, email: user.email },
        agency: agencyRows[0] || null
      });
    }

    // --- C. CONNEXION AGENCE (/auth/v1/token) ---
    if (pathname === '/auth/v1/token' && req.method === 'POST') {
      if (!ensureDbAvailable(res)) return;
      if (!checkRateLimit('auth:' + ip, 20, 15 * 60000)) {
        return sendJson(res, 429, { error_description: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.' });
      }
      const { email, password } = await readJsonBody(req);
      const cleanEmail = String(email || '').trim().toLowerCase();
      const user = await Store.findUserByEmail(cleanEmail);
      if (!user || !verifyPassword(password, user.password_hash)) {
        return sendJson(res, 401, { error_description: 'Email ou mot de passe incorrect.' });
      }
      const agRows = await Store.getAgency(user.id);
      if (agRows[0] && agRows[0].suspended) {
        return sendJson(res, 403, { error_description: 'Compte agence suspendu par l\'administrateur ParcAuto.' });
      }
      const token = signJwt({ sub: user.id, email: user.email });
      return sendJson(res, 200, {
        access_token: token,
        token_type: 'bearer',
        user: { id: user.id, email: user.email },
        agency: agRows[0] || null
      });
    }

    // --- D. PROFIL & SNAPSHOT AGENCE (/rest/v1/agencies) — PROTÉGÉ PAR JWT ---
    if (pathname === '/rest/v1/agencies') {
      if (!ensureDbAvailable(res)) return;
      const agencyId = requireAuthAgency(req, res);
      if (!agencyId) return;

      const eqId = urlObj.searchParams.get('id');
      if (eqId && eqId.startsWith('eq.') && eqId.slice(3) !== agencyId) {
        return sendJson(res, 403, { error: 'Accès interdit aux données d\'une autre agence.' });
      }

      if (req.method === 'GET') {
        const rows = await Store.getAgency(agencyId);
        return sendJson(res, 200, rows);
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const rows = Array.isArray(body) ? body : [body];
        const saved = await Store.upsertAgency(agencyId, rows[0] || {});
        return sendJson(res, 201, saved);
      }
    }

    // --- E. TABLES MÉTIER MULTI-AGENCES (/rest/v1/vehicles, etc.) — PROTÉGÉES PAR JWT ---
    for (const table of TABLES) {
      if (pathname === `/rest/v1/${table}`) {
        if (!ensureDbAvailable(res)) return;
        const agencyId = requireAuthAgency(req, res);
        if (!agencyId) return;

        if (req.method === 'GET') {
          const rows = await Store.getTable(table, agencyId);
          return sendJson(res, 200, rows);
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const replaceAll = urlObj.searchParams.get('sync') === 'full';
          const count = await Store.upsertTable(table, agencyId, body, replaceAll);
          return sendJson(res, 201, { status: 'synced', agency_id: agencyId, count });
        }
      }
    }

    // --- F. DEMANDES DE DÉMO / PROSPECTS (/rest/v1/leads) ---
    if (pathname === '/rest/v1/leads') {
      if (!ensureDbAvailable(res)) return;
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const rows = Array.isArray(body) ? body : [body];
        for (const r of rows) {
          await Store.createLead(r || {});
        }
        return sendJson(res, 201, { status: 'lead_saved' });
      }
      if (req.method === 'GET') {
        const reqKey = req.headers['x-admin-key'] || '';
        if (!ADMIN_KEY || reqKey !== ADMIN_KEY) {
          return sendJson(res, 403, { error: 'Accès réservé à l\'administrateur.' });
        }
        const leads = await Store.listAllLeads();
        return sendJson(res, 200, leads);
      }
    }

    // --- F2. CONSOLE PROPRIÉTAIRE / SUPER-ADMIN (/api/admin/*) ---
    if (pathname.startsWith('/api/admin/')) {
      if (!ensureDbAvailable(res)) return;
      const reqKey = req.headers['x-admin-key'] || '';
      if (!ADMIN_KEY || reqKey !== ADMIN_KEY) {
        return sendJson(res, 403, { error: 'Clé Propriétaire (Admin) invalide.' });
      }
      if (pathname === '/api/admin/overview' && req.method === 'GET') {
        const [agencies, leads] = await Promise.all([Store.listAllAgencies(), Store.listAllLeads()]);
        return sendJson(res, 200, { agencies, leads });
      }
      if (pathname === '/api/admin/create-agency' && req.method === 'POST') {
        const { email, password, company, owner_name, city, phone, plan, trial_days } = await readJsonBody(req);
        const cleanEmail = String(email || '').trim().toLowerCase();
        if (!cleanEmail || !cleanEmail.includes('@')) {
          return sendJson(res, 400, { error: 'Email invalide.' });
        }
        if (!password || String(password).length < 6) {
          return sendJson(res, 400, { error: 'Mot de passe trop court (min. 6 caractères).' });
        }
        const existing = await Store.findUserByEmail(cleanEmail);
        if (existing) {
          return sendJson(res, 400, { error: 'Cet email possède déjà un compte agence.' });
        }
        const user = await Store.createUser(cleanEmail, hashPassword(password), {
          company: company || 'Nouvelle Agence',
          owner_name: owner_name || 'Gérant',
          city: city || 'Casablanca',
          phone: phone || '',
          plan: plan || 'pro',
          trial_days: trial_days != null ? +trial_days : 30
        });
        const ag = await Store.getAgency(user.id);
        return sendJson(res, 201, { user: { id: user.id, email: cleanEmail }, agency: ag[0] });
      }
      if (pathname === '/api/admin/update-agency' && req.method === 'POST') {
        const { agency_id, plan, trial_days, suspended } = await readJsonBody(req);
        const updated = await Store.updateAgencyStatus(agency_id, { plan, trial_days, suspended });
        if (!updated) return sendJson(res, 404, { error: 'Agence introuvable.' });
        return sendJson(res, 200, { agency: updated });
      }
    }

    // --- F3. AUTOMATISATION PAIEMENT EN LIGNE & RENOUVELLEMENT (/api/billing/* & /api/webhooks/payment) ---
    if (pathname === '/api/billing/checkout' && req.method === 'POST') {
      if (!ensureDbAvailable(res)) return;
      const agencyId = requireAuthAgency(req, res);
      if (!agencyId) return;
      const { plan, period } = await readJsonBody(req);
      const addDays = period === 'year' ? 365 : 30;
      const currentRows = await Store.getAgency(agencyId);
      const curDays = currentRows[0] ? (currentRows[0].trial_days || 0) : 0;
      const updated = await Store.updateAgencyStatus(agencyId, {
        plan: plan || 'pro',
        trial_days: curDays + addDays,
        suspended: false
      });
      return sendJson(res, 200, { status: 'paid_and_activated', agency: updated });
    }

    if (pathname === '/api/webhooks/payment' && req.method === 'POST') {
      if (!ensureDbAvailable(res)) return;
      const { email, agency_id, plan, period, webhook_secret } = await readJsonBody(req);
      const expectedSecret = process.env.PAYMENT_WEBHOOK_SECRET || ADMIN_KEY;
      if (webhook_secret !== expectedSecret && req.headers['x-webhook-secret'] !== expectedSecret) {
        return sendJson(res, 403, { error: 'Signature Webhook invalide.' });
      }
      let targetId = agency_id;
      if (!targetId && email) {
        const u = await Store.findUserByEmail(String(email).trim().toLowerCase());
        if (u) targetId = u.id;
      }
      if (!targetId) return sendJson(res, 404, { error: 'Agence introuvable pour ce paiement.' });
      const addDays = period === 'year' ? 365 : 30;
      const updated = await Store.updateAgencyStatus(targetId, {
        plan: plan || 'pro',
        trial_days: addDays,
        suspended: false
      });
      return sendJson(res, 200, { status: 'webhook_processed', agency: updated });
    }

    // --- G. SERVIR LE SITE FRONT-END (ParcAuto.html / index.html) ---
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/ParcAuto.html')) {
      const candidates = [
        path.join(__dirname, 'ParcAuto.html'),
        path.join(__dirname, 'index.html'),
        path.join(__dirname, 'public', 'index.html')
      ];
      const htmlPath = candidates.find(p => fs.existsSync(p));
      if (htmlPath) {
        const htmlContent = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(htmlContent);
      }
    }

    return sendJson(res, 404, { error: 'Route introuvable' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Erreur interne du serveur' });
  }
});

if (require.main === module) {
  initPostgresIfConfigured().then(() => {
    server.listen(PORT, () => {
      console.log(`============================================================`);
      console.log(`🚗 ParcAuto Maroc — Serveur Back-End & Base de données actif`);
      console.log(`🌐 Application : http://localhost:${PORT}`);
      console.log(`🔒 Sécurité    : JWT obligatoire par agence + Rate-Limiting`);
      console.log(`💾 Stockage    : ${pgPool ? 'PostgreSQL (DATABASE_URL)' : DB_FILE}`);
      console.log(`============================================================`);
    });
  });
}

module.exports = { server, initPostgresIfConfigured };
