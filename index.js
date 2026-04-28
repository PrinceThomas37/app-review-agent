// ─────────────────────────────────────────────────────────────────────────────
// APP REVIEW AI AGENT — Backend Server
// Runs on Render. Fetches reviews from AppFollow, analyses with Claude API,
// stores in Supabase, sends weekly email reports, fires emergency alerts.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const cors    = require("cors");
const cron    = require("node-cron");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── ENV VARIABLES (set these in Render dashboard) ───────────────────────────
// APPFOLLOW_API_KEY   — your AppFollow API key
// APPFOLLOW_APP_ID    — your app's ext_id (e.g. com.yourapp.android or 1234567890)
// GROQ_API_KEY        — from console.groq.com (free, no credit card needed)
// SUPABASE_URL        — from your Supabase project settings
// SUPABASE_KEY        — Supabase service_role key
// GMAIL_USER          — your Gmail address (e.g. you@gmail.com)
// GMAIL_APP_PASSWORD  — 16-char Gmail App Password (NOT your normal password)
// REPORT_EMAIL        — where to send weekly reports (can be same as GMAIL_USER)
// APP_NAME            — display name of your app (e.g. "MyApp")
// EMERGENCY_KEYWORDS  — comma-separated (e.g. crash,fraud,refund,hack,broken)
// RATING_THRESHOLD    — avg rating below this triggers alert (e.g. 3.0)
// NEGATIVE_PCT_THRESHOLD — % negative reviews that triggers alert (e.g. 40)
// LOW_STAR_SPIKE_PCT  — % of 1-2 star reviews that triggers alert (e.g. 30)

const GROQ_KEY        = process.env.GROQ_API_KEY;
const APPFOLLOW_KEY   = process.env.APPFOLLOW_API_KEY;
const APPFOLLOW_APP   = process.env.APPFOLLOW_APP_ID;
const APP_NAME        = process.env.APP_NAME || "My App";
const EMERGENCY_KW    = (process.env.EMERGENCY_KEYWORDS || "crash,crashes,freeze,freezing,fraud,refund,scam,hack,stolen,broken,error,data loss").split(",").map(k => k.trim().toLowerCase());
const RATING_THRESH   = parseFloat(process.env.RATING_THRESHOLD || "3.0");
const NEG_PCT_THRESH  = parseInt(process.env.NEGATIVE_PCT_THRESHOLD || "40");
const SPIKE_THRESH    = parseInt(process.env.LOW_STAR_SPIKE_PCT || "30");

// ─── SUPABASE CLIENT ─────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── EMAIL TRANSPORTER ───────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Call Groq API (free, no credit card needed)
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1500,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Groq API error");
  const text = data.choices?.[0]?.message?.content || "";
  return text.replace(/```json\n?|\n?```/g, "").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Fetch reviews from AppFollow
// ─────────────────────────────────────────────────────────────────────────────
async function fetchReviews() {
  console.log("Fetching reviews from AppFollow...");
  const url = `https://api.appfollow.io/api/1.0/reviews?ext_id=${APPFOLLOW_APP}&country=all&per_page=10&page=1`;
  const res = await fetch(url, {
    headers: { "X-AppFollow-API-Token": APPFOLLOW_KEY },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AppFollow API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const raw = data.reviews || data.data || data.list || [];
  console.log(`Fetched ${raw.length} reviews`);
  return raw.map((r) => ({
    ext_id:   String(r.id || r.review_id || Math.random()),
    text:     r.text || r.body || r.content || "",
    rating:   Number(r.rating || r.stars || r.score || 0),
    date:     r.date || r.created_at || new Date().toISOString().split("T")[0],
    platform: r.store || r.platform || "unknown",
    author:   r.author || r.username || r.user_name || "Anonymous",
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Analyse reviews with Claude (in batches of 8)
// ─────────────────────────────────────────────────────────────────────────────
async function analyseReviews(reviews) {
  console.log(`Analysing ${reviews.length} reviews with Claude...`);
  const kwList = EMERGENCY_KW.slice(0, 8).join(", ");
  const results = [];

  for (let i = 0; i < reviews.length; i += 8) {
    const batch = reviews.slice(i, i + 8);
    const input = batch.map((r, j) => ({
      i: i + j,
      rating:   r.rating,
      text:     r.text.slice(0, 400),
      platform: r.platform,
      date:     r.date,
    }));

    try {
      const json = await callClaude(
        "You are a mobile app review analyst. Return ONLY a JSON array, no markdown, no explanation.",
        `Analyse these reviews. Return a JSON array where each item:
{
  "i": <original index number>,
  "sentiment": "positive" | "negative" | "neutral",
  "priority": "critical" | "high" | "medium" | "low",
  "summary": "one sentence summary",
  "issues": ["problem 1", "problem 2"],
  "positives": ["positive 1"],
  "is_emergency": true/false
}

Set is_emergency=true if the review mentions any of: ${kwList}

Reviews: ${JSON.stringify(input)}`
      );

      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) {
        parsed.forEach((r) => {
          if (typeof r.i === "number" && r.i < reviews.length) {
            results[r.i] = { ...reviews[r.i], ...r };
          }
        });
      }
    } catch (e) {
      console.error(`Batch ${i} analysis error:`, e.message);
      batch.forEach((r, j) => {
        results[i + j] = { ...r, sentiment: "neutral", priority: "low", summary: "", issues: [], positives: [], is_emergency: false };
      });
    }
  }

  // Fill any gaps
  reviews.forEach((r, i) => {
    if (!results[i]) results[i] = { ...r, sentiment: "neutral", priority: "low", summary: "", issues: [], positives: [], is_emergency: false };
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Detect emergency conditions
// ─────────────────────────────────────────────────────────────────────────────
function detectAlerts(analysed) {
  const alerts = [];
  const neg    = analysed.filter((r) => r.sentiment === "negative").length;
  const negPct = Math.round((neg / analysed.length) * 100);
  const avg    = analysed.reduce((s, r) => s + r.rating, 0) / analysed.length;
  const lowStar = Math.round((analysed.filter((r) => r.rating <= 2).length / analysed.length) * 100);
  const emergRevs = analysed.filter((r) => r.is_emergency);

  if (emergRevs.length > 0)
    alerts.push({ type: "keywords", severity: "critical", msg: `${emergRevs.length} review${emergRevs.length > 1 ? "s" : ""} flagged for critical keywords (crash, fraud, etc.)` });
  if (lowStar > SPIKE_THRESH)
    alerts.push({ type: "spike", severity: "high", msg: `${lowStar}% of reviews are 1–2 stars — spike above ${SPIKE_THRESH}% threshold` });
  if (negPct > NEG_PCT_THRESH)
    alerts.push({ type: "sentiment", severity: "high", msg: `${negPct}% negative sentiment exceeds ${NEG_PCT_THRESH}% threshold` });
  if (avg < RATING_THRESH)
    alerts.push({ type: "rating", severity: "high", msg: `Average rating ${avg.toFixed(1)} is below ${RATING_THRESH} threshold` });

  return alerts;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: Generate weekly report with Claude
// ─────────────────────────────────────────────────────────────────────────────
async function generateReport(analysed) {
  console.log("Generating weekly report...");
  const stats = {
    total:    analysed.length,
    avgRating: (analysed.reduce((s, r) => s + r.rating, 0) / analysed.length).toFixed(2),
    positive: analysed.filter((r) => r.sentiment === "positive").length,
    negative: analysed.filter((r) => r.sentiment === "negative").length,
    neutral:  analysed.filter((r) => r.sentiment === "neutral").length,
    critical: analysed.filter((r) => r.priority === "critical").length,
  };
  const issues    = analysed.flatMap((r) => r.issues    || []).join(", ").slice(0, 800);
  const positives = analysed.flatMap((r) => r.positives || []).join(", ").slice(0, 400);
  const summaries = analysed.map((r) => `[${r.platform}][${r.rating}★][${r.priority}] ${r.summary}`).slice(0, 30).join("\n");

  const json = await callClaude(
    "You are a senior product analyst. Return ONLY valid JSON, no markdown.",
    `Generate a weekly app review report for ${APP_NAME}. Return JSON:
{
  "overallTrend": "improving" | "declining" | "stable" | "mixed",
  "executiveSummary": "2-3 sentences",
  "top5Problems": [{"rank":1, "issue":"...", "severity":"critical|high|medium"}],
  "top5Positives": [{"rank":1, "feature":"..."}],
  "recommendedActions": ["action 1", "action 2", "action 3"]
}
Stats: ${JSON.stringify(stats)}
Issues: ${issues}
Positives: ${positives}
Summaries:\n${summaries}`
  );

  return { ...JSON.parse(json), stats, generatedAt: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5: Save to Supabase
// ─────────────────────────────────────────────────────────────────────────────
async function saveToSupabase(analysed, report) {
  console.log("Saving to Supabase...");

  // Upsert reviews (won't duplicate if same ext_id already exists)
  const reviewRows = analysed.map((r) => ({
    ext_id:      r.ext_id,
    text:        r.text,
    rating:      r.rating,
    date:        r.date,
    platform:    r.platform,
    author:      r.author,
    sentiment:   r.sentiment,
    priority:    r.priority,
    summary:     r.summary,
    issues:      r.issues,
    positives:   r.positives,
    is_emergency: r.is_emergency,
    analysed_at: new Date().toISOString(),
  }));

  const { error: revErr } = await supabase
    .from("reviews")
    .upsert(reviewRows, { onConflict: "ext_id" });
  if (revErr) console.error("Supabase reviews error:", revErr.message);

  // Insert weekly report
  const { error: repErr } = await supabase.from("reports").insert([{
    generated_at:      report.generatedAt,
    overall_trend:     report.overallTrend,
    executive_summary: report.executiveSummary,
    top5_problems:     report.top5Problems,
    top5_positives:    report.top5Positives,
    recommended_actions: report.recommendedActions,
    stats:             report.stats,
  }]);
  if (repErr) console.error("Supabase reports error:", repErr.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6: Send email
// ─────────────────────────────────────────────────────────────────────────────
async function sendEmail(subject, htmlBody) {
  await transporter.sendMail({
    from:    `"${APP_NAME} Review Agent" <${process.env.GMAIL_USER}>`,
    to:      process.env.REPORT_EMAIL,
    subject,
    html:    htmlBody,
  });
  console.log("Email sent to", process.env.REPORT_EMAIL);
}

function buildReportEmail(report, alerts) {
  const alertSection = alerts.length
    ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px;margin-bottom:24px">
        <strong style="color:#dc2626">⚠ Emergency Alerts</strong>
        <ul style="margin:8px 0 0;padding-left:20px;color:#dc2626">
          ${alerts.map((a) => `<li>${a.msg}</li>`).join("")}
        </ul>
       </div>`
    : "";

  const trendColor = report.overallTrend === "improving" ? "#16a34a" : report.overallTrend === "declining" ? "#dc2626" : "#6b7280";

  return `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">
<h1 style="font-size:20px;font-weight:600;margin-bottom:4px">${APP_NAME} — Weekly Review Report</h1>
<p style="color:#6b7280;font-size:13px;margin-bottom:24px">${new Date(report.generatedAt).toLocaleDateString("en-IN", { weekday:"long", year:"numeric", month:"long", day:"numeric" })}</p>

${alertSection}

<div style="background:#f9fafb;border-radius:8px;padding:16px;margin-bottom:24px">
  <span style="font-size:13px;color:#6b7280">Overall Trend: </span>
  <strong style="color:${trendColor}">${(report.overallTrend||"").toUpperCase()}</strong>
  <p style="margin:12px 0 0;font-size:14px;line-height:1.6">${report.executiveSummary}</p>
</div>

<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px">
  ${[["Reviews", report.stats.total], ["Avg Rating", report.stats.avgRating + "★"], ["Positive", report.stats.positive], ["Negative", report.stats.negative]]
    .map(([l,v]) => `<div style="background:#f3f4f6;border-radius:8px;padding:12px;text-align:center"><div style="font-size:11px;color:#6b7280">${l}</div><div style="font-size:20px;font-weight:600;margin-top:4px">${v}</div></div>`).join("")}
</div>

<h2 style="font-size:15px;font-weight:600;color:#dc2626;margin-bottom:12px">🔴 Top Problems</h2>
<ol style="padding-left:20px;margin-bottom:24px">
  ${(report.top5Problems||[]).map((p) => `<li style="margin-bottom:6px;font-size:14px">${p.issue} <span style="font-size:11px;color:#6b7280">[${p.severity}]</span></li>`).join("")}
</ol>

<h2 style="font-size:15px;font-weight:600;color:#16a34a;margin-bottom:12px">🟢 Top Positives</h2>
<ol style="padding-left:20px;margin-bottom:24px">
  ${(report.top5Positives||[]).map((p) => `<li style="margin-bottom:6px;font-size:14px">${p.feature}</li>`).join("")}
</ol>

<h2 style="font-size:15px;font-weight:600;margin-bottom:12px">Recommended Actions</h2>
<ol style="padding-left:20px;margin-bottom:24px">
  ${(report.recommendedActions||[]).map((a) => `<li style="margin-bottom:6px;font-size:14px">${a}</li>`).join("")}
</ol>

<p style="font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:16px">
  Auto-generated by ${APP_NAME} Review Agent • Powered by Claude AI
</p>
</body></html>`;
}

function buildEmergencyEmail(alerts) {
  return `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">
<div style="background:#fef2f2;border:2px solid #dc2626;border-radius:8px;padding:20px">
  <h1 style="font-size:18px;color:#dc2626;margin:0 0 12px">🚨 EMERGENCY ALERT — ${APP_NAME}</h1>
  <p style="font-size:14px;margin-bottom:16px">Critical issues detected in app reviews. Immediate attention required.</p>
  <ul style="padding-left:20px;margin:0">
    ${alerts.map((a) => `<li style="margin-bottom:8px;font-size:14px;color:#dc2626">${a.msg}</li>`).join("")}
  </ul>
</div>
<p style="font-size:12px;color:#9ca3af;margin-top:16px">Auto-generated by ${APP_NAME} Review Agent</p>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PIPELINE — runs the full fetch → analyse → report → email flow
// ─────────────────────────────────────────────────────────────────────────────
async function runPipeline() {
  console.log("\n===== PIPELINE STARTED =====", new Date().toISOString());
  try {
    const raw      = await fetchReviews();
    if (!raw.length) { console.log("No reviews found. Stopping."); return; }

    const analysed = await analyseReviews(raw);
    const alerts   = detectAlerts(analysed);

    // Send emergency email immediately if critical issues found
    if (alerts.length > 0) {
      console.log(`${alerts.length} alert(s) detected — sending emergency email`);
      await sendEmail(`🚨 EMERGENCY: ${APP_NAME} Review Alert`, buildEmergencyEmail(alerts));
    }

    const report = await generateReport(analysed);
    await saveToSupabase(analysed, report);

    // Send weekly report email
    const subject = `📊 Weekly Review Report — ${APP_NAME} — ${new Date().toLocaleDateString("en-IN")}`;
    await sendEmail(subject, buildReportEmail(report, alerts));

    console.log("===== PIPELINE COMPLETE =====\n");
    return { success: true, reviewCount: analysed.length, alerts, report };
  } catch (e) {
    console.error("Pipeline error:", e.message);
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON SCHEDULE — runs every Sunday at 9:00 AM IST (3:30 AM UTC)
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule("30 3 * * 0", () => {
  console.log("Cron triggered — starting weekly pipeline");
  runPipeline().catch(console.error);
});

// ─────────────────────────────────────────────────────────────────────────────
// REST API ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Manually trigger the full pipeline from the dashboard
app.post("/api/run", async (req, res) => {
  try {
    const result = await runPipeline();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get all stored reviews from Supabase
app.get("/api/reviews", async (req, res) => {
  const { data, error } = await supabase
    .from("reviews")
    .select("*")
    .order("date", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Get all stored reports from Supabase
app.get("/api/reports", async (req, res) => {
  const { data, error } = await supabase
    .from("reports")
    .select("*")
    .order("generated_at", { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Health check — Render uses this to verify the service is alive
app.get("/health", (req, res) => {
  res.json({ status: "ok", app: APP_NAME, time: new Date().toISOString() });
});

// Serve the dashboard for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n${APP_NAME} Review Agent running on port ${PORT}`);
  console.log(`Schedule: Every Sunday 9:00 AM IST`);
  console.log(`App ID: ${APPFOLLOW_APP || "(not set)"}\n`);
});
