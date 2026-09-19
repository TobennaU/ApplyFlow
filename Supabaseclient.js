import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://mauolrmxayuwsujymboh.supabase.co/rest/v1/";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_6WfZtGvZoyZGoofgrU-cYQ_k6jAWLnE";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
