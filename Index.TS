import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;

// The browser sends a preflight OPTIONS request before calling this function.
// Without these headers on every response, the browser blocks the call.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const { resume_id, application_id } = await req.json();
    if (!resume_id || !application_id) {
      return json({ error: "resume_id and application_id are required" }, 400);
    }

    // client scoped to the caller, to confirm they own both rows
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: "Not authenticated" }, 401);

    const { data: resume } = await userClient
      .from("resumes")
      .select("id, parsed_text")
      .eq("id", resume_id)
      .single();

    if (!resume) return json({ error: "Resume not found" }, 404);
    if (!resume.parsed_text) {
      return json({ error: "This resume has no extracted text. Upload it as a PDF with selectable text." }, 400);
    }

    const { data: application } = await userClient
      .from("applications")
      .select("id, job_title, company, job_description, notes")
      .eq("id", application_id)
      .single();

    if (!application) return json({ error: "Application not found" }, 404);

    const prompt = `
You are a career coach reviewing a resume against a specific job.

Job title: ${application.job_title}
Company: ${application.company}
Job description: ${application.job_description || "Not provided"}
Applicant's notes: ${application.notes || "None"}

Resume text:
"""
${resume.parsed_text.slice(0, 12000)}
"""

Respond with ONLY valid JSON, no markdown formatting, in this shape:
{
  "match_score": <0-100 integer>,
  "strengths": ["short bullet", ...],
  "gaps": ["short bullet", ...],
  "suggestions": ["specific, actionable edit to the resume", ...]
}
`.trim();

    const geminiResponse = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
      }),
    });

    if (!geminiResponse.ok) {
      console.error("Gemini error:", await geminiResponse.text());
      return json({ error: "The AI request failed. Check the function logs." }, 502);
    }

    const geminiData = await geminiResponse.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

    let recommendations;
    try {
      recommendations = JSON.parse(text);
    } catch {
      return json({ error: "The AI returned an unreadable response. Try again." }, 502);
    }

    // service role write (skips RLS) — ownership was already confirmed above
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: saved, error: saveError } = await adminClient
      .from("resume_feedback")
      .upsert(
        { user_id: user.id, resume_id, application_id, recommendations },
        { onConflict: "resume_id,application_id" },
      )
      .select()
      .single();

    if (saveError) {
      console.error("Save error:", saveError);
      return json({ error: "Could not save feedback" }, 500);
    }

    return json(saved);
  } catch (err) {
    console.error(err);
    return json({ error: "Unexpected error" }, 500);
  }
});