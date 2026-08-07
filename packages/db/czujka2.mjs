import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [r] = await sql`
  select
    (select count(*)::int from heartbeat_runs where status='failed' and created_at > now() - interval '15 minutes') pady15,
    (select count(*)::int from heartbeat_runs where created_at > now() - interval '15 minutes') wszystkie15,
    (select count(*)::int from agent_wakeup_requests where reason='heartbeat.daily_run_limit' and requested_at > now() - interval '15 minutes') odbicia_sufit15,
    (select count(*)::int from agent_wakeup_requests where reason='heartbeat.timer.no_actionable_work' and requested_at > now() - interval '15 minutes') pominiete15,
    (select coalesce((runtime_config->'heartbeat'->>'maxDailyRuns')::int,0) from agents where name='Recenzent') sufit_recenzenta`;
console.log(JSON.stringify(r));
await sql.end();
