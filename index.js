// ─────────────────────────────────────────────────────────────────────────────
// APP REVIEW AI AGENT — Backend Server
// Fetches reviews from BOTH Android and iOS via AppFollow, analyses with Groq,
// stores in Supabase, sends weekly email reports and emergency alerts.
// ─────────────────────────────────────────────────────────────────────────────

const express    = require("express");
const cors       = require("cors");
const cron       = require("node-cron");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");
const path       = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── ENV VARIABLES (set these in Render dashboard) ───────────────────────────
// APPFOLLOW_API_KEY        — your AppFollow API key
// APPFOLLOW_APP_ID_ANDROID — Android app ext_id (e.g. com.cris.irctc)
// APPFOLLOW_APP_ID_IOS     — iOS app ext_id (e.g. 1234567890)
// GROQ_API_KEY             — from console.groq.com (free)
// SUPABASE_URL             — from Supabase project settings
// SUPABASE_KEY             — Supabase service_role key
// GMAIL_USER               — your Gmail address
// GMAIL_APP_PASSWORD       — 16-char Gmail App Password
// REPORT_EMAIL             — where to send reports
// APP_NAME                 — your app display name (e.g. IRCTC)
// EMERGENCY_KEYWORDS       — comma-separated keywords
// RATING_THRESHOLD         — avg rating below this triggers alert (e.g. 3.0)
// NEGATIVE_PCT_THRESHOLD   — % negative reviews threshold (e.g. 40)
// LOW_STAR_SPIKE_PCT       — % 1-2 star spike threshold (e.g. 30)

const GROQ_KEY     = process.env.GROQ_API_KEY;
const AF_KEY       = process.env.APPFOLLOW_API_KEY;
const AF_ANDROID   = process.env.APPFOLLOW_APP_ID_ANDROID;
const AF_IOS       = process.env.APPFOLLOW_APP_ID_IOS;
const APP_NAME     = process.env.APP_NAME || "My App";
const EMERGENCY_KW = (process.env.EMERGENCY_KEYWORDS || "crash,crashes,freeze,freezing,fraud,refund,scam,hack,stolen,broken,error,data loss").split(",").map(k => k.trim().toLowerCase());
const RATING_THRESH  = parseFloat(process.env.RATING_THRESHOLD || "3.0");
const NEG_PCT_THRESH = parseInt(process.env.NEGATIVE_PCT_THRESHOLD || "40");
const SPIKE_THRESH   = parseInt(process.env.LOW_STAR_SPIKE_PCT || "30");

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
// HELPER: Call Groq AI (free)
// ─────────────────────────────────────────────────────────────────────────────
async function callAI(systemPrompt, userPrompt) {
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
// STEP 1: Fetch reviews from AppFollow for one app ID
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFromAppFollow(extId, platform) {
  if (!extId) return [];
  console.log(`Fetching ${platform} reviews for ${extId}...`);
  const url = `https://api.appfollow.io/api/1.0/reviews?ext_id=${extId}&country=all&per_page=10&page=1`;
  const res = await fetch(url, {
    headers: { "X-AppFollow-API-Token": AF_KEY },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AppFollow ${platform} error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const raw = data.reviews || data.data || data.list || [];
  console.log(`Got ${raw.length} ${platform} reviews`);
  return raw.map((r) => ({
    ext_id:   `${platform}_${r.id || r.review_id || Math.random()}`,
    text:     r.text || r.body || r.content || "",
    rating:   Number(r.rating || r.stars || r.score || 0),
    date:     r.date || r.created_at || new Date().toISOString().split("T")[0],
    platform: platform,
    author:   r.author || r.username || r.user_name || "Anonymous",
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Fetch from BOTH Android and iOS and combine
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAllReviews() {
  const [androidReviews, iosReviews] = await Promise.allSettled([
    fetchFromAppFollow(AF_ANDROID, "Android"),
    fetchFromAppFollow(AF_IOS, "iOS"),
  ]);

  const combined = [
    ...(androidReviews.status === "fulfilled" ? androidReviews.value : []),
    ...(iosReviews.status    === "fulfilled" ? iosReviews.value    : []),
  ];

  if (androidReviews.status === "rejected") console.error("Android fetch failed:", androidReviews.reason.message);
  if (iosReviews.status    === "rejected") console.error("iOS fetch failed:",     iosReviews.reason.message);

  console.log(`Total combined reviews: ${combined.length}`);
  return combined;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Analyse reviews with Groq AI (batches of 8)
// ─────────────────────────────────────────────────────────────────────────────
async function analyseReviews(reviews) {
  console.log(`Analysing ${reviews.length} reviews with Groq...`);
  const kwList = EMERGENCY_KW.slice(0, 8).join(", ");
  const results = [];

  for (let i = 0; i < reviews.length; i += 8) {
    const batch = reviews.slice(i, i + 8);
    const input = batch.map((r, j) => ({
      i:        i + j,
      rating:   r.rating,
      text:     r.text.slice(0, 400),
      platform: r.platform,
      date:     r.date,
    }));

    try {
      const json = await callAI(
        "You are a mobile app review analyst. Return ONLY a JSON array, no markdown, no explanation.",
        `Analyse these app reviews. Return a JSON array where each item has:
{
  "i": <original index number>,
  "sentiment": "positive" | "negative" | "neutral",
  "priority": "critical" | "high" | "medium" | "low",
  "summary": "one sentence summary",
  "issues": ["problem 1", "problem 2"],
  "positives": ["good thing 1"],
  "is_emergency": true or false
}
Set is_emergency=true if review mentions: ${kwList}
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
      console.error(`Batch ${i} error:`, e.message);
      batch.forEach((r, j) => {
        results[i + j] = { ...r, sentiment: "neutral", priority: "low", summary: "", issues: [], positives: [], is_emergency: false };
      });
    }
  }

  reviews.forEach((r, i) => {
    if (!results[i]) results[i] = { ...r, sentiment: "neutral", priority: "low", summary: "", issues: [], positives: [], is_emergency: false };
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: Detect emergency conditions
// ─────────────────────────────────────────────────────────────────────────────
function detectAlerts(analysed) {
  const alerts  = [];
  const neg     = analysed.filter((r) => r.sentiment === "negative").length;
  const negPct  = Math.round((neg / analysed.length) * 100);
  const avg     = analysed.reduce((s, r) => s + r.rating, 0) / analysed.length;
  const lowStar = Math.round((analysed.filter((r) => r.rating <= 2).length / analysed.length) * 100);
  const emerg   = analysed.filter((r) => r.is_emergency);

  if (emerg.length > 0)
    alerts.push({ severity: "critical", msg: `${emerg.length} review${emerg.length > 1 ? "s" : ""} flagged for critical keywords` });
  if (lowStar > SPIKE_THRESH)
    alerts.push({ severity: "high", msg: `${lowStar}% of reviews are 1–2 stars — spike above ${SPIKE_THRESH}% threshold` });
  if (negPct > NEG_PCT_THRESH)
    alerts.push({ severity: "high", msg: `${negPct}% negative sentiment exceeds ${NEG_PCT_THRESH}% threshold` });
  if (avg < RATING_THRESH)
    alerts.push({ severity: "high", msg: `Average rating ${avg.toFixed(1)} is below ${RATING_THRESH} threshold` });

  return alerts;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5: Generate weekly report with Groq
// ─────────────────────────────────────────────────────────────────────────────
async function generateReport(analysed) {
  console.log("Generating weekly report...");

  const stats = {
    total:     analysed.length,
    android:   analysed.filter((r) => r.platform === "Android").length,
    ios:       analysed.filter((r) => r.platform === "iOS").length,
    avgRating: (analysed.reduce((s, r) => s + r.rating, 0) / analysed.length).toFixed(2),
    positive:  analysed.filter((r) => r.sentiment === "positive").length,
    negative:  analysed.filter((r) => r.sentiment === "negative").length,
    neutral:   analysed.filter((r) => r.sentiment === "neutral").length,
    critical:  analysed.filter((r) => r.priority === "critical").length,
  };

  const issues    = analysed.flatMap((r) => r.issues    || []).join(", ").slice(0, 800);
  const positives = analysed.flatMap((r) => r.positives || []).join(", ").slice(0, 400);
  const summaries = analysed.map((r) => `[${r.platform}][${r.rating}★][${r.priority}] ${r.summary}`).slice(0, 30).join("\n");

  const json = await callAI(
    "You are a senior product analyst. Return ONLY valid JSON, no markdown.",
    `Generate a weekly app review report for ${APP_NAME}. Return JSON:
{
  "overallTrend": "improving" | "declining" | "stable" | "mixed",
  "executiveSummary": "2-3 sentences",
  "top5Problems": [{"rank": 1, "issue": "...", "severity": "critical|high|medium"}],
  "top5Positives": [{"rank": 1, "feature": "..."}],
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
// STEP 6: Save to Supabase
// ─────────────────────────────────────────────────────────────────────────────
async function saveToSupabase(analysed, report) {
  console.log("Saving to Supabase...");

  const reviewRows = analysed.map((r) => ({
    ext_id:       r.ext_id,
    text:         r.text,
    rating:       r.rating,
    date:         r.date,
    platform:     r.platform,
    author:       r.author,
    sentiment:    r.sentiment,
    priority:     r.priority,
    summary:      r.summary,
    issues:       r.issues,
    positives:    r.positives,
    is_emergency: r.is_emergency,
    analysed_at:  new Date().toISOString(),
  }));

  const { error: revErr } = await supabase
    .from("reviews")
    .upsert(reviewRows, { onConflict: "ext_id" });
  if (revErr) console.error("Supabase reviews error:", revErr.message);

  const { error: repErr } = await supabase.from("reports").insert([{
    generated_at:        report.generatedAt,
    overall_trend:       report.overallTrend,
    executive_summary:   report.executiveSummary,
    top5_problems:       report.top5Problems,
    top5_positives:      report.top5Positives,
    recommended_actions: report.recommendedActions,
    stats:               report.stats,
  }]);
  if (repErr) console.error("Supabase reports error:", repErr.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7: Send email
// ─────────────────────────────────────────────────────────────────────────────
async function sendEmail(subject, htmlBody) {
  await transporter.sendMail({
    from: `"${APP_NAME} Review Agent" <${process.env.GMAIL_USER}>`,
    to:   process.env.REPORT_EMAIL,
    subject,
    html: htmlBody,
  });
  console.log("Email sent to", process.env.REPORT_EMAIL);
}

function buildReportEmail(report, alerts) {
  const alertSection = alerts.length
    ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px;margin-bottom:24px">
        <strong style="color:#dc2626">Emergency Alerts</strong>
        <ul style="margin:8px 0 0;padding-left:20px;color:#dc2626">
          ${alerts.map((a) => `<li>${a.msg}</li>`).join("")}
        </ul>
       </div>`
    : "";

  const trendColor = report.overallTrend === "improving" ? "#16a34a" : report.overallTrend === "declining" ? "#dc2626" : "#6b7280";

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">
<h1 style="font-size:20px;font-weight:600;margin-bottom:4px">${APP_NAME} Weekly Review Report</h1>
<p style="color:#6b7280;font-size:13px;margin-bottom:24px">${new Date(report.generatedAt).toLocaleDateString("en-IN",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</p>
${alertSection}
<div style="background:#f9fafb;border-radius:8px;padding:16px;margin-bottom:24px">
  <span style="font-size:13px;color:#6b7280">Overall Trend: </span>
  <strong style="color:${trendColor}">${(report.overallTrend||"").toUpperCase()}</strong>
  <p style="margin:12px 0 0;font-size:14px;line-height:1.6">${report.executiveSummary}</p>
</div>
<table style="width:100%;border-collapse:collapse;margin-bottom:24px">
  <tr>
    ${[["Total",report.stats.total],["Android",report.stats.android],["iOS",report.stats.ios],["Avg Rating",report.stats.avgRating+"★"],["Positive",report.stats.positive],["Negative",report.stats.negative]]
      .map(([l,v])=>`<td style="background:#f3f4f6;border-radius:8px;padding:10px;text-align:center;font-size:12px"><div style="color:#6b7280">${l}</div><div style="font-size:18px;font-weight:600;margin-top:2px">${v}</div></td>`).join("")}
  </tr>
</table>
<h2 style="font-size:15px;color:#dc2626;margin-bottom:12px">Top Problems</h2>
<ol style="padding-left:20px;margin-bottom:24px">
  ${(report.top5Problems||[]).map(p=>`<li style="margin-bottom:6px;font-size:14px">${p.issue} <span style="font-size:11px;color:#6b7280">[${p.severity}]</span></li>`).join("")}
</ol>
<h2 style="font-size:15px;color:#16a34a;margin-bottom:12px">Top Positives</h2>
<ol style="padding-left:20px;margin-bottom:24px">
  ${(report.top5Positives||[]).map(p=>`<li style="margin-bottom:6px;font-size:14px">${p.feature}</li>`).join("")}
</ol>
<h2 style="font-size:15px;margin-bottom:12px">Recommended Actions</h2>
<ol style="padding-left:20px;margin-bottom:24px">
  ${(report.recommendedActions||[]).map(a=>`<li style="margin-bottom:6px;font-size:14px">${a}</li>`).join("")}
</ol>
<p style="font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:16px">Auto-generated by ${APP_NAME} Review Agent · Powered by Groq AI</p>
</body></html>`;
}

function buildEmergencyEmail(alerts) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
<div style="background:#fef2f2;border:2px solid #dc2626;border-radius:8px;padding:20px">
  <h1 style="font-size:18px;color:#dc2626;margin:0 0 12px">EMERGENCY ALERT — ${APP_NAME}</h1>
  <p style="font-size:14px;margin-bottom:16px">Critical issues detected. Immediate attention required.</p>
  <ul style="padding-left:20px;margin:0">
    ${alerts.map(a=>`<li style="margin-bottom:8px;font-size:14px;color:#dc2626">${a.msg}</li>`).join("")}
  </ul>
</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────────────────────────────────────
async function runPipeline() {
  console.log("\n===== PIPELINE STARTED =====", new Date().toISOString());
  try {
    const raw = await fetchAllReviews();
    if (!raw.length) {
      console.log("No reviews found. Stopping.");
      return { success: true, reviewCount: 0, alerts: [] };
    }

    const analysed = await analyseReviews(raw);
    const alerts   = detectAlerts(analysed);

    if (alerts.length > 0) {
      console.log(`${alerts.length} alert(s) — sending emergency email`);
      await sendEmail(`EMERGENCY: ${APP_NAME} Review Alert`, buildEmergencyEmail(alerts));
    }

    const report = await generateReport(analysed);
    await saveToSupabase(analysed, report);
    await sendEmail(
      `Weekly Review Report — ${APP_NAME} — ${new Date().toLocaleDateString("en-IN")}`,
      buildReportEmail(report, alerts)
    );

    console.log("===== PIPELINE COMPLETE =====\n");
    return { success: true, reviewCount: analysed.length, alerts, report };
  } catch (e) {
    console.error("Pipeline error:", e.message);
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON — every Sunday at 9:00 AM IST (3:30 AM UTC)
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule("30 3 * * 0", () => {
  console.log("Cron triggered — starting weekly pipeline");
  runPipeline().catch(console.error);
});

// ─────────────────────────────────────────────────────────────────────────────
// API ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/run", async (req, res) => {
  try {
    const result = await runPipeline();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/reviews", async (req, res) => {
  const { data, error } = await supabase.from("reviews").select("*").order("date", { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get("/api/reports", async (req, res) => {
  const { data, error } = await supabase.from("reports").select("*").order("generated_at", { ascending: false }).limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", app: APP_NAME, android: AF_ANDROID || "not set", ios: AF_IOS || "not set", time: new Date().toISOString() });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n${APP_NAME} Review Agent running on port ${PORT}`);
  console.log(`Android: ${AF_ANDROID || "not set"}`);
  console.log(`iOS:     ${AF_IOS     || "not set"}`);
  console.log(`Schedule: Every Sunday 9:00 AM IST\n`);
});
