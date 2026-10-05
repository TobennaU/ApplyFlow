// Keep one client for the whole app so auth sessions stay in sync.
export { supabase } from './Supabaseclient.js'
import { supabase } from './Supabaseclient.js'

// Every function returns the data or throws an Error with a readable message.
function unwrap({ data, error }) {
  if (error) throw new Error(error.message)
  return data
}

async function requireUser() {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) throw new Error('You need to be logged in.')
  return data.user
}

// ---------- Auth ----------

export async function signUp(email, password, name) {
  return unwrap(
    await supabase.auth.signUp({ email, password, options: { data: { name } } })
  )
}

export async function signIn(email, password) {
  return unwrap(await supabase.auth.signInWithPassword({ email, password }))
}

export async function signOut() {
  unwrap(await supabase.auth.signOut())
}

export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser()
  return data.user // null if logged out
}

export async function getProfile() {
  const user = await requireUser()
  return unwrap(
    await supabase.from('profiles').select('*').eq('id', user.id).single()
  )
}

// ---------- Applications ----------

export async function listApplications(status = null) {
  let q = supabase
    .from('applications')
    .select('*')
    .order('application_date', { ascending: false })
  if (status) q = q.eq('application_status', status)
  return unwrap(await q)
}

// fields: { job_title, company, location?, job_description?, notes?,
//           application_status?, application_date?, job_listing_id? }
export async function addApplication(fields) {
  const user = await requireUser()
  return unwrap(
    await supabase
      .from('applications')
      .insert({ ...fields, user_id: user.id })
      .select()
      .single()
  )
}

export async function updateApplication(id, changes) {
  return unwrap(
    await supabase
      .from('applications')
      .update(changes)
      .eq('id', id)
      .select()
      .single()
  )
}

// status: 'Applied' | 'Interview' | 'Offer' | 'Rejected'
export function setApplicationStatus(id, status) {
  return updateApplication(id, { application_status: status })
}

export async function deleteApplication(id) {
  unwrap(await supabase.from('applications').delete().eq('id', id))
}

// ---------- Job listings ----------

export async function listJobs({ search = '', limit = 20 } = {}) {
  let q = supabase
    .from('job_listings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (search) q = q.or(`title.ilike.%${search}%,company.ilike.%${search}%`)
  return unwrap(await q)
}

// fields: { title, company, location?, description?, job_url?, source? }
export async function addJob(fields) {
  return unwrap(
    await supabase.from('job_listings').insert(fields).select().single()
  )
}

// ---------- Saved jobs ----------

export async function listSavedJobs() {
  return unwrap(
    await supabase
      .from('saved_jobs')
      .select('id, saved_at, job_listings(*)')
      .order('saved_at', { ascending: false })
  )
}

export async function saveJob(jobListingId) {
  const user = await requireUser()
  return unwrap(
    await supabase
      .from('saved_jobs')
      .insert({ user_id: user.id, job_listing_id: jobListingId })
      .select()
      .single()
  )
}

export async function unsaveJob(jobListingId) {
  unwrap(
    await supabase.from('saved_jobs').delete().eq('job_listing_id', jobListingId)
  )
}

// ---------- Resumes ----------

export async function listResumes() {
  return unwrap(
    await supabase
      .from('resumes')
      .select('id, file_name, file_path, uploaded_at')
      .order('uploaded_at', { ascending: false })
  )
}

// Uploads the file to the private 'resumes' bucket at <user_id>/<filename>
// and saves a row in the resumes table.
// Keyword matching needs text, so .txt/.md files are read in the browser.
// For PDFs, pass the extracted text as parsedText (see README notes).
export async function uploadResume(file, parsedText = null) {
  const user = await requireUser()
  const filePath = `${user.id}/${file.name}`

  const isPlainText =
    file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name)
  if (parsedText === null && isPlainText) parsedText = await file.text()

  const { error: uploadError } = await supabase.storage
    .from('resumes')
    .upload(filePath, file, { upsert: true })
  if (uploadError) throw new Error(uploadError.message)

  return unwrap(
    await supabase
      .from('resumes')
      .insert({
        user_id: user.id,
        file_name: file.name,
        file_path: filePath,
        parsed_text: parsedText,
      })
      .select('id, file_name, file_path, uploaded_at')
      .single()
  )
}

export async function deleteResume(resume) {
  // resume = { id, file_path }
  const { error } = await supabase.storage
    .from('resumes')
    .remove([resume.file_path])
  if (error) throw new Error(error.message)
  unwrap(await supabase.from('resumes').delete().eq('id', resume.id))
}

// Temporary link so the user can open/download their own resume file.
export async function getResumeUrl(filePath, expiresInSeconds = 60) {
  const data = unwrap(
    await supabase.storage
      .from('resumes')
      .createSignedUrl(filePath, expiresInSeconds)
  )
  return data.signedUrl
}

// ---------- Match scoring ----------

// Calls the 'match-resume' Edge Function, which computes and saves the score.
// Returns { match_score, analysis: { matched, missing, ... } }
export async function runMatch(resumeId, jobListingId) {
  const { data, error } = await supabase.functions.invoke('match-resume', {
    body: { resume_id: resumeId, job_listing_id: jobListingId },
  })
  if (error) {
    // Try to surface the function's own error message
    let message = error.message
    try {
      const body = await error.context.json()
      if (body?.error) message = body.error
    } catch (_) {}
    throw new Error(message)
  }
  return data
}

// Previously computed scores (read-only from the client).
export async function getMatches(resumeId) {
  return unwrap(
    await supabase
      .from('match_results')
      .select('id, match_score, analysis, created_at, job_listings(*)')
      .eq('resume_id', resumeId)
      .order('match_score', { ascending: false })
  )
}
