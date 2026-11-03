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

// Removes characters that would break a PostgREST filter string.
function cleanTerm(text) {
  return String(text ?? '').replace(/[,()%*\\]/g, ' ').trim()
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

// ---------- Two-factor authentication (authenticator app codes) ----------

// currentLevel is 'aal1' after a password sign-in and 'aal2' after a code.
// If nextLevel is 'aal2' the user has 2FA on and still owes a code.
export async function getMfaStatus() {
  const { data: level, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (error) throw new Error(error.message)
  const { data: factors, error: factorError } = await supabase.auth.mfa.listFactors()
  if (factorError) throw new Error(factorError.message)
  return {
    currentLevel: level.currentLevel,
    nextLevel: level.nextLevel,
    factors: factors.totp, // verified authenticator factors only
  }
}

// Returns { id, totp: { qr_code, secret } } to show the user.
export async function enrollTotp() {
  // clear out any half-finished setup from earlier attempts
  const { data: factors } = await supabase.auth.mfa.listFactors()
  for (const factor of factors?.all ?? []) {
    if (factor.factor_type === 'totp' && factor.status === 'unverified') {
      await supabase.auth.mfa.unenroll({ factorId: factor.id })
    }
  }
  return unwrap(
    await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'ApplyFlow authenticator' })
  )
}

// Used both to finish setup and to answer a sign-in challenge.
export async function verifyTotp(factorId, code) {
  const { data: challenge, error } = await supabase.auth.mfa.challenge({ factorId })
  if (error) throw new Error(error.message)
  return unwrap(
    await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code })
  )
}

export async function disableTotp(factorId) {
  unwrap(await supabase.auth.mfa.unenroll({ factorId }))
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
//           application_status?, application_date?, job_listing_id?,
//           interview_date?, follow_up_date? }
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

// search matches title, company, and description; location matches the location text
export async function listJobs({ search = '', location = '', limit = 20, source = '' } = {}) {
  let q = supabase
    .from('job_listings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (source) q = q.eq('source', source)

  const place = cleanTerm(location)
  if (place) q = q.ilike('location', `%${place}%`)

  const term = cleanTerm(search)
  if (term) {
    q = q.or(`title.ilike.%${term}%,company.ilike.%${term}%,description.ilike.%${term}%`)
  }
  return unwrap(await q)
}

// Asks the 'fetch-jobs' Edge Function to pull postings into job_listings.
// With no keyword or location it refreshes only stale sources; with one it
// runs a fresh search.
export async function refreshJobs({ keyword = '', location = '' } = {}) {
  const { data, error } = await supabase.functions.invoke('fetch-jobs', {
    body: { keyword, location },
  })
  if (error) throw new Error(error.message)
  return data
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

const DOCX_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export async function listResumes() {
  return unwrap(
    await supabase
      .from('resumes')
      .select('id, file_name, file_path, uploaded_at, parsed_text')
      .order('uploaded_at', { ascending: false })
  )
}

// pdf.js and mammoth are loaded by <script> tags in index.html and
// expose the globals pdfjsLib and mammoth.
async function extractPdfText(file) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'

  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
  let text = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map((item) => item.str).join(' ') + '\n'
  }
  return text.trim()
}

async function extractDocxText(file) {
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
  return result.value.trim()
}

// Uploads the file to the private 'resumes' bucket at <user_id>/<filename>
// and saves its row. PDF, Word (.docx), and plain text files are read so the
// AI can use them. Uploading the same file name again replaces the old copy.
export async function uploadResume(file, parsedText = null) {
  const user = await requireUser()
  const filePath = `${user.id}/${file.name}`

  if (parsedText === null) {
    try {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        parsedText = await extractPdfText(file)
      } else if (file.type === DOCX_TYPE || /\.docx$/i.test(file.name)) {
        parsedText = await extractDocxText(file)
      } else if (file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name)) {
        parsedText = await file.text()
      }
    } catch (err) {
      console.error('Could not read text from the resume:', err)
    }
  }

  const { error: uploadError } = await supabase.storage
    .from('resumes')
    .upload(filePath, file, { upsert: true })
  if (uploadError) throw new Error(uploadError.message)

  return unwrap(
    await supabase
      .from('resumes')
      .upsert(
        {
          user_id: user.id,
          file_name: file.name,
          file_path: filePath,
          parsed_text: parsedText || null,
          uploaded_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,file_path' }
      )
      .select('id, file_name, file_path, uploaded_at, parsed_text')
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

// ---------- AI resume feedback ----------

// Calls the 'analyze-resume' Edge Function, which saves its result to
// resume_feedback. Returns the saved row: { recommendations, resume_id, created_at, ... }
export async function getFeedback(resumeId, applicationId) {
  const { data, error } = await supabase.functions.invoke('analyze-resume', {
    body: { resume_id: resumeId, application_id: applicationId },
  })
  if (error) {
    let message = error.message
    try {
      const body = await error.context.json()
      if (body?.error) message = body.error
    } catch (_) {}
    throw new Error(message)
  }
  return data
}

// Every saved feedback result for this user, newest first.
export async function listFeedback() {
  return unwrap(
    await supabase
      .from('resume_feedback')
      .select('id, application_id, resume_id, recommendations, created_at')
      .order('created_at', { ascending: false })
  )
}