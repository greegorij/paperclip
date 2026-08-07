import postgres from "postgres";
import fs from "node:fs";
const url = fs.readFileSync("/home/ccuser/.config/paperclip-agent-env","utf8").match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,"");
const sql = postgres(url, { max: 1, connect_timeout: 10 });
const t = new Date().toISOString().slice(11,19);
try {
  const [a] = await sql`SELECT
    count(*) FILTER (WHERE created_at > now()-interval '15 minutes')::int ost15,
    count(*) FILTER (WHERE created_at > now()-interval '15 minutes' AND status='failed')::int pad15,
    count(*) FILTER (WHERE created_at > now()-interval '15 minutes' AND status='succeeded')::int ok15
    FROM heartbeat_runs`;
  const [b] = await sql`SELECT count(*)::int otwarte FROM issues WHERE identifier IN ('GG-935','GG-936','GG-928','GG-929','GG-930','GG-931','GG-932','GG-925') AND status NOT IN ('done','cancelled')`;
  const [c] = await sql`SELECT COALESCE(round(sum(input_tokens+output_tokens)/1000000.0,1),0) mln FROM cost_events WHERE occurred_at > now()-interval '1 hour'`;
  const d = await sql`SELECT left(COALESCE(error,'-'),45) b, count(*)::int n FROM heartbeat_runs WHERE created_at > now()-interval '15 minutes' AND status='failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 2`;
  const alarm = a.pad15 > 20 ? " 🔴LAWINA" : (d[0] && d[0].n > 10 ? " 🔴POWTORKA" : "");
  console.log(`${t} przebiegi15=${a.ost15} ok=${a.ok15} pad=${a.pad15} | lancuchFrappe_otwarte=${b.otwarte}/8 | mln_jednostek_1h=${c.mln}${alarm}` + (d[0]?` | top_blad="${d[0].b}"x${d[0].n}`:""));
} catch(e) { console.log(t + " BLAD NADZORU: " + e.message); } finally { await sql.end(); }
