import { createClient } from "npm:@supabase/supabase-js@2";

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

// The job boards ask API users not to poll often, so listings are cached in
// the job_listings table and a source is only refetched when its newest
// listing is this old.
const REFRESH_AFTER_HOURS = 12;

function stripHtml(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- sources ----------

async function fetchRemotive() {
  const response = await fetch("https://remotive.com/api/remote-jobs?limit=100");
  if (!response.ok) throw new Error(`Remotive responded ${response.status}`);

  const { jobs } = await response.json();
  return (jobs ?? [])
    .filter((j: any) => j.url && j.title && j.company_name)
    .map((j: any) => ({
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || "Remote",
      description: stripHtml(j.description ?? "").slice(0, 5000),
      job_url: j.url,
      source: "remotive",
    }));
}

// USAJOBS needs a free key, plus the email you registered it with.
// If the secrets aren't set, this source is skipped and Remotive still works.
async function fetchUsajobs() {
  const key = Deno.env.get("USAJOBS_API_KEY");
  const email = Deno.env.get("USAJOBS_USER_AGENT_EMAIL");
  if (!key || !email) return null;

  const response = await fetch(
    "https://data.usajobs.gov/api/search?ResultsPerPage=100&WhoMayApply=public&SortField=opendate&SortDirection=desc",
    { headers: { "User-Agent": email, "Authorization-Key": key } },
  );
  if (!response.ok) throw new Error(`USAJOBS responded ${response.status}`);

  const data = await response.json();
  const items = data?.SearchResult?.SearchResultItems ?? [];

  return items
    .map((item: any) => item.MatchedObjectDescriptor)
    .filter((j: any) => j?.PositionURI && j?.PositionTitle)
    .map((j: any) => ({
      title: j.PositionTitle,
      company: j.OrganizationName || j.DepartmentName || "U.S. Government",
      location: j.PositionLocationDisplay || "United States",
      description: stripHtml(
        j.UserArea?.Details?.JobSummary || j.QualificationSummary || "",
      ).slice(0, 5000),
      job_url: j.PositionURI,
      source: "usajobs",
    }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // only signed-in users can trigger a refresh
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated" }, 401);

    // service role, because regular users can't write to job_listings in bulk
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    async function isStale(source: string) {
      const { data: latest } = await admin
        .from("job_listings")
        .select("created_at")
        .eq("source", source)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!latest) return true;
      const ageHours = (Date.now() - new Date(latest.created_at).getTime()) / 36e5;
      return ageHours >= REFRESH_AFTER_HOURS;
    }

    const [remotiveStale, usajobsStale] = await Promise.all([
      isStale("remotive"),
      isStale("usajobs"),
    ]);

    // one source failing shouldn't stop the other
    const results = await Promise.allSettled([
      remotiveStale ? fetchRemotive() : Promise.resolve(null),
      usajobsStale ? fetchUsajobs() : Promise.resolve(null),
    ]);

    const rows: any[] = [];
    let failures = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value) rows.push(...result.value);
      } else {
        failures++;
        console.error("Job source failed:", result.reason);
      }
    }

    if (rows.length === 0) {
      return failures > 0
        ? json({ error: "Could not reach the job sources." }, 502)
        : json({ refreshed: false });
    }

    // job_url is unique, so jobs we already have are skipped
    const { data: added, error } = await admin
      .from("job_listings")
      .upsert(rows, { onConflict: "job_url", ignoreDuplicates: true })
      .select("id");

    if (error) {
      console.error("Save error:", error);
      return json({ error: "Could not save job listings." }, 500);
    }

    return json({ refreshed: true, added: added?.length ?? 0 });
  } catch (err) {
    console.error(err);
    return json({ error: "Unexpected error" }, 500);
  }
});
