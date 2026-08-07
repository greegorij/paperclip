import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [r] = await sql`
  select
    (select count(*)::int from heartbeat_runs where status='failed' and created_at > now() - interval '15 minutes') pady15,
    (select count(*)::int from heartbeat_runs where created_at > now() - interval '15 minutes') wszystkie15,
    (select count(*)::int from heartbeat_runs where status='succeeded' and created_at > now() - interval '15 minutes') ok15,
    (select count(*)::int from agents where (runtime_config->'heartbeat'->>'enabled')::boolean is true) puls_wl,
    (select count(*)::int from agents where paused_at is not null) wstrzymani`;
console.log(JSON.stringify(r));
await sql.end();
