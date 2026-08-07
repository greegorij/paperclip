import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (label, sql) => {
  try { const r = await c.query(sql); console.log(label, JSON.stringify(r.rows)); }
  catch (e) { console.log(label, 'BLAD:', e.message); }
};
await q('doba_wg_statusu:', `select status, count(*)::int from heartbeat_runs where created_at > now() - interval '24 hours' group by 1 order by 2 desc`);
await q('godzina_wg_statusu:', `select status, count(*)::int from heartbeat_runs where created_at > now() - interval '1 hour' group by 1 order by 2 desc`);
await q('ostatnie_3:', `select status, created_at from heartbeat_runs order by created_at desc limit 3`);
await q('agenci_puls:', `select count(*)::int total, count(*) filter (where "heartbeatEnabled")::int wlaczony from agents`);
await c.end();
