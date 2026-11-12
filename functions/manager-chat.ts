// Supabase Edge Function: Danny chats with the manager from the iPhone app.
// The manager answers in seconds, can open tasks for agents, save Danny's ideas,
// and start an immediate work run on GitHub Actions.
//
// Telegram: set TELEGRAM_BOT_TOKEN, then open <fn-url>?setup=telegram once, then /start in the bot.
// Secrets (supabase secrets set ...): ANTHROPIC_API_KEY, ALLOWED_EMAIL, GH_TOKEN, GH_REPO (owner/repo),
// optional MANAGER_MODEL. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are provided automatically.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const WORKERS = ["researcher", "editor", "content", "campaigner"];
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const TG = "https://api.telegram.org/bot";
const tgToken = () => Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
async function tgSecret(): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("lareverie:" + tgToken()));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
async function tgSend(chat_id: number | string, text: string) {
  for (let i = 0; i < text.length; i += 3900)
    await fetch(`${TG}${tgToken()}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id, text: text.slice(i, i + 3900) }) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);

  // --- one-time Telegram webhook setup: open <function-url>?setup=telegram ---
  if (req.method === "GET" && url.searchParams.get("setup") === "telegram") {
    if (!tgToken()) return json({ error: "TELEGRAM_BOT_TOKEN secret missing" }, 400);
    const hook = `https://${url.host}/functions/v1/manager-chat`;
    const r = await fetch(`${TG}${tgToken()}/setWebhook`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: hook, secret_token: await tgSecret(), allowed_updates: ["message"] }) });
    const me = await (await fetch(`${TG}${tgToken()}/getMe`)).json();
    return json({ webhook: await r.json(), bot: me.result?.username, next: "Open the bot in Telegram and send /start" });
  }

  // --- Telegram message from Danny ---
  if (req.headers.get("x-telegram-bot-api-secret-token")) {
    if (req.headers.get("x-telegram-bot-api-secret-token") !== await tgSecret()) return json({ error: "bad secret" }, 401);
    const upd = await req.json();
    const msg = upd.message; const chatId = msg?.chat?.id; const text: string = msg?.text ?? "";
    if (!chatId || !text) return json({ ok: true });
    const { data: row } = await db.from("kv").select("value").eq("key", "telegram_chat_id").maybeSingle();
    const owner = row?.value;
    if (!owner) {
      if (!text.startsWith("/start")) return json({ ok: true });
      await db.from("kv").upsert({ key: "telegram_chat_id", value: chatId, at: new Date().toISOString() });
      await tgSend(chatId, "✅ מחובר! אני רייצ'ל, המנהלת של La Réverie USA. כתוב לי כל דבר: \"תתחילו לעבוד עכשיו\", \"מה המצב?\", רעיונות. הדוחות וההתראות יגיעו לכאן.");
      await db.from("chat").insert({ role: "manager", text: "✅ טלגרם חובר. מעכשיו אפשר לדבר איתי גם משם." });
      return json({ ok: true });
    }
    if (String(owner) !== String(chatId)) return json({ ok: true });   // only Danny
    if (text.startsWith("/start")) { await tgSend(chatId, "אני כאן 👋 מה תרצה?"); return json({ ok: true }); }
    // @ts-ignore EdgeRuntime is provided by Supabase
    EdgeRuntime.waitUntil((async () => {
      await fetch(`${TG}${tgToken()}/sendChatAction`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing" }) });
      try { await tgSend(chatId, await handle(db, text)); } catch (e) { await tgSend(chatId, "⚠️ תקלה: " + String(e).slice(0, 200)); }
    })());
    return json({ ok: true });
  }

  // --- app (iPhone/desktop): only Danny ---
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user || user.email?.toLowerCase() !== (Deno.env.get("ALLOWED_EMAIL") ?? "dannymit16@gmail.com").toLowerCase()) return json({ error: "unauthorized" }, 401);
  const { text } = await req.json();
  if (!text?.trim()) return json({ error: "empty" }, 400);
  return json({ reply: await handle(db, text) });
});

async function handle(db: any, text: string): Promise<string> {
  await db.from("chat").insert({ role: "danny", text });

  // --- context ---
  const [chat, tasks, status, fin, learn, kv] = await Promise.all([
    db.from("chat").select("role,text,at").order("id", { ascending: false }).limit(30),
    db.from("tasks").select("id,agent,title,status,kind,result").in("status", ["pending", "rework", "done", "failed", "escalated"]),
    db.from("agent_status").select("*"),
    db.from("finance_days").select("data").order("day", { ascending: false }).limit(7),
    db.from("learnings").select("kind,text,at").order("id", { ascending: false }).limit(20),
    db.from("kv").select("key,value"),
  ]);
  const kvMap = Object.fromEntries((kv.data ?? []).map((r) => [r.key, r.value]));
  const today = new Date().toISOString().slice(0, 10);
  const { data: todayEvents } = await db.from("events").select("kind,agent,data,at").gte("at", today).order("id").limit(200);

  const system = `${kvMap.manager_instructions ?? "You are the manager of an AI agent team running Danny's US dropshipping store."}

# You are now chatting live with Danny (the owner) in his phone app.
- Answer in Hebrew, short and direct (mobile). Numbers first when relevant.
- If he gives an instruction or idea: act on it — create tasks for the right agents, save ideas with save_idea,
  and use run_agents_now when he wants it done now. Tell him exactly what you did.
- Money caps in settings are hard limits; if he asks to exceed them, tell him to change settings.yaml.
- Never invent numbers; use the data below.

# Live data
Settings: ${JSON.stringify(kvMap.settings ?? {})}
Approved budget caps (override settings): ${JSON.stringify(kvMap.budget_caps ?? null)}
Pending budget request from the campaigner: ${JSON.stringify(kvMap.budget_request ?? null)}
Monthly goal status: ${JSON.stringify(kvMap.goal ?? {})}
Today's P&L (updated every 30 min): ${JSON.stringify(kvMap.today_pnl ?? {})}
Last 7 days: ${JSON.stringify(fin.data ?? [])}
Agents right now: ${JSON.stringify(status.data ?? [])}
Open tasks: ${JSON.stringify(tasks.data ?? [])}
Today's events: ${JSON.stringify(todayEvents ?? [])}
Lessons: ${JSON.stringify(learn.data ?? [])}`;

  const messages: any[] = (chat.data ?? []).reverse().map((m) => ({
    role: m.role === "danny" ? "user" : "assistant", content: m.text,
  }));
  // API requires alternating roles starting with user
  const merged: any[] = [];
  for (const m of messages) {
    if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += "\n\n" + m.content;
    else merged.push({ ...m });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();

  const tools = [
    { name: "create_task", description: `Create a task for an agent (${WORKERS.join(", ")}). kind: task|launch|optimize|fix`,
      input_schema: { type: "object", properties: { agent: { type: "string" }, title: { type: "string" }, instructions: { type: "string" }, kind: { type: "string" } }, required: ["agent", "title", "instructions"] } },
    { name: "cancel_task", description: "Cancel an open task by id",
      input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
    { name: "save_idea", description: "Save Danny's idea/rule as a lesson the manager applies every morning",
      input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "set_budget_caps", description: "Set new ad budget caps. ONLY when Danny explicitly approves (e.g. 'מאשר' to a pending budget_request, or names numbers).",
      input_schema: { type: "object", properties: { daily: { type: "number" }, monthly: { type: "number" } }, required: ["daily", "monthly"] } },
    { name: "run_agents_now", description: "Start a work round now instead of waiting for the schedule. step: midday (work+review) | plan | report",
      input_schema: { type: "object", properties: { step: { type: "string" } }, required: ["step"] } },
  ];

  const runTool = async (name: string, input: any) => {
    const now = new Date().toISOString();
    if (name === "create_task") {
      if (!WORKERS.includes(input.agent)) return { error: "unknown agent" };
      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      await db.from("tasks").insert({ id, agent: input.agent, kind: input.kind ?? "task", title: input.title, instructions: input.instructions,
        status: "pending", created_by: "manager", created_at: now, updated_at: now, attempts: 0, data: { from: "danny_chat" }, review_notes: [] });
      await db.from("events").insert({ kind: "task_created", agent: "manager", data: { task_id: id, to: input.agent, title: input.title, from: "chat" }, day: today });
      await db.from("messages").insert({ sender: "manager", recipient: input.agent, text: `📁 ${input.title}: ${input.instructions}` });
      return { task_id: id };
    }
    if (name === "cancel_task") {
      await db.from("tasks").update({ status: "archived", updated_at: now }).eq("id", input.task_id);
      return { ok: true };
    }
    if (name === "save_idea") {
      await db.from("learnings").insert({ kind: "idea", text: `רעיון של דני: ${input.text}` });
      return { ok: true };
    }
    if (name === "set_budget_caps") {
      await db.from("kv").upsert({ key: "budget_caps", value: { daily: input.daily, monthly: input.monthly, approved_at: now }, at: now });
      await db.from("kv").delete().eq("key", "budget_request");
      await db.from("events").insert({ kind: "budget_approved", agent: "manager", data: input, day: today });
      return { ok: true };
    }
    if (name === "run_agents_now") {
      if (!Deno.env.get("GH_TOKEN")) {
        await db.from("kv").upsert({ key: "run_requested", value: { step: input.step ?? "midday", at: now }, at: now });
        return { queued: true, note: "Agents start at the next hourly check (within 60 min)" };
      }
      const r = await fetch(`https://api.github.com/repos/${Deno.env.get("GH_REPO") ?? "dannymit16/dropship-agents"}/dispatches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${Deno.env.get("GH_TOKEN")}`, Accept: "application/vnd.github+json" },
        body: JSON.stringify({ event_type: "run-now", client_payload: { step: input.step ?? "midday" } }),
      });
      return r.ok ? { started: true, note: "Agents start in ~1 minute" } : { error: await r.text() };
    }
    return { error: "unknown tool" };
  };

  let reply = "";
  for (let turn = 0; turn < 8; turn++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("MANAGER_MODEL") ?? "claude-opus-5-5", max_tokens: 2000, system, tools, messages: merged }),
    });
    if (!r.ok) { reply = "⚠️ תקלה בחיבור למודל: " + (await r.text()).slice(0, 200); break; }
    const res = await r.json();
    merged.push({ role: "assistant", content: res.content });
    const calls = res.content.filter((c: any) => c.type === "tool_use");
    if (!calls.length) { reply = res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""); break; }
    const results = [];
    for (const c of calls) results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(await runTool(c.name, c.input)) });
    merged.push({ role: "user", content: results });
  }
  if (!reply) reply = "בוצע ✅";
  await db.from("chat").insert({ role: "manager", text: reply });
  return reply;
}
