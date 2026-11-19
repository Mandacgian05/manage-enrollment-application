<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import EnrollmentCaptcha from '@/components/EnrollmentCaptcha.vue';
import { ageAt, schoolLevels, sectionsFor, todayInManila, validateApplication, type Application, type FieldErrors } from '@/lib/enrollment/form';
import { documentBucket, documentFileError, formatFileSize, uploadSlotsFor } from '@/lib/enrollment/documents';
import { getPublicSupabaseClient } from '@/lib/supabase';

type Config = { status: 'open' | 'closed'; schoolYear: string; siteKey: string; periodId: string | null; documentUploads?: boolean };
type UploadTicket = { requirement: string; path: string; token: string; contentType: string; ticket: string };
type UploadState = { label: string; state: 'waiting' | 'uploading' | 'checking' | 'done' | 'failed'; message?: string };
const config = ref<Config>();
const loading = ref(true);
const message = ref('');
const data = reactive<Application>({
  ...Object.fromEntries(sectionsFor({ level: 'SHS' }).flatMap(section => section.fields.map(field => [field.key, '']))),
  level: 'JHS',
});
const sections = computed(() => sectionsFor(data));
const errors = ref<FieldErrors>({});
const reviewing = ref(false);
const busy = ref(false);
const confirmed = ref(false);
const privacyConsent = ref(false);
const token = ref('');
const captcha = ref<InstanceType<typeof EnrollmentCaptcha>>();
const receipt = ref<{ reference: string; status: string; message: string }>();
const submissionId = ref(crypto.randomUUID());
const errorSummary = ref<HTMLElement>();
const reviewHeading = ref<HTMLElement>();
const receiptHeading = ref<HTMLElement>();

// Online Requirement Uploads START
// Optional: one file per document-type requirement. Files are uploaded only after the
// application is saved, straight to private storage, then checked by the server.
const files = reactive<Record<string, File>>({});
const fileErrors = reactive<Record<string, string>>({});
const uploads = ref<Record<string, UploadState>>({});
const uploadsBusy = ref(false);
const uploadsUnavailable = ref(false);
const slots = computed(() => (config.value?.documentUploads ? uploadSlotsFor(data) : []));
const chosenFiles = computed(() => slots.value.filter(slot => files[slot.key]).map(slot => ({ slot, file: files[slot.key] })));
watch(slots, current => {
  if (receipt.value) return; // The form is cleared after submission; keep the files for uploading.
  const keys = new Set(current.map(slot => slot.key));
  for (const key of Object.keys(files)) if (!keys.has(key)) { delete files[key]; delete fileErrors[key]; }
});
function chooseFile(key: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const problem = documentFileError(file);
  if (problem) { fileErrors[key] = problem; delete files[key]; return; }
  delete fileErrors[key];
  files[key] = file;
}
function removeFile(key: string) { delete files[key]; delete fileErrors[key]; }

type PendingFile = { label: string; file: File };
async function uploadDocuments(tickets: UploadTicket[], pending: Record<string, PendingFile>) {
  uploads.value = Object.fromEntries(tickets.map(ticket => [ticket.requirement, { label: pending[ticket.requirement]?.label ?? ticket.requirement, state: 'waiting' }]));
  uploadsBusy.value = true;
  const sent: UploadTicket[] = [];
  try {
    const storage = getPublicSupabaseClient().storage.from(documentBucket);
    for (const ticket of tickets) {
      const file = pending[ticket.requirement]?.file;
      const entry = uploads.value[ticket.requirement];
      if (!file) { Object.assign(entry, { state: 'failed', message: 'The file was no longer selected.' }); continue; }
      entry.state = 'uploading';
      try {
        const { error } = await storage.uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: ticket.contentType });
        if (error) throw error;
        entry.state = 'checking';
        sent.push(ticket);
      } catch {
        Object.assign(entry, { state: 'failed', message: 'The upload did not finish.' });
      }
    }
    if (sent.length) {
      try {
        const response = await fetch('/api/enrollment/documents', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tickets: sent.map(ticket => ticket.ticket) }), signal: AbortSignal.timeout(120_000),
        });
        const result = await response.json();
        if (!response.ok || !Array.isArray(result.results)) throw new Error();
        for (const item of result.results as { requirement: string; ok: boolean; message?: string }[]) {
          const entry = uploads.value[item.requirement];
          if (entry) Object.assign(entry, item.ok ? { state: 'done', message: undefined } : { state: 'failed', message: item.message });
        }
      } catch {
        for (const ticket of sent) Object.assign(uploads.value[ticket.requirement], { state: 'failed', message: 'The file could not be checked.' });
      }
      for (const ticket of sent) {
        const entry = uploads.value[ticket.requirement];
        if (entry.state === 'checking') Object.assign(entry, { state: 'failed', message: 'The file could not be checked.' });
      }
    }
  } finally {
    uploadsBusy.value = false;
    // Discard the files from the page once they are handled.
    Object.keys(files).forEach(key => delete files[key]);
  }
}
const uploadLabels: Record<UploadState['state'], string> = {
  waiting: 'Waiting', uploading: 'Uploading…', checking: 'Checking…', done: 'Received', failed: 'Not received',
};
// Online Requirement Uploads END

watch(() => data.level, () => { data.gradeLevel = ''; data.strand = ''; delete errors.value.gradeLevel; delete errors.value.strand; });
watch(() => data.gradeLevel, () => { data.strand = ''; delete errors.value.strand; });
watch(() => data.birthday, value => { data.age = ageAt(value ?? ''); });
async function loadConfig() {
  loading.value = true;
  message.value = '';
  try {
    const response = await fetch('/api/enrollment/config', { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error();
    const result: Config = await response.json();
    if (!['open', 'closed'].includes(result.status) || !result.siteKey || (result.status === 'open' && (!result.schoolYear || !result.periodId))) throw new Error();
    config.value = result;
    data.schoolYear = result.schoolYear;
  } catch { message.value = 'Enrollment is temporarily unavailable. Please try again shortly.'; }
  finally { loading.value = false; }
}
onMounted(loadConfig);
async function focusErrors() { await nextTick(); errorSummary.value?.focus(); }
function validateField(key: string) {
  if (!config.value) return;
  const error = validateApplication(data, config.value.schoolYear).errors[key];
  if (error) errors.value[key] = error;
  else delete errors.value[key];
}
function revalidateField(key: string) { if (errors.value[key]) validateField(key); }
function validateCurrentApplication(): boolean {
  if (!config.value) return false;
  const validated = validateApplication(data, config.value.schoolYear);
  errors.value = validated.errors;
  if (Object.keys(errors.value).length) return false;
  Object.assign(data, validated.data);
  return true;
}
async function review() {
  if (!validateCurrentApplication()) { await focusErrors(); return; }
  message.value = '';
  reviewing.value = true;
  await nextTick(); reviewHeading.value?.focus();
}
async function edit() {
  reviewing.value = false;
  token.value = '';
  confirmed.value = false;
  privacyConsent.value = false;
  await nextTick(); document.querySelector<HTMLElement>('#level')?.focus();
}
async function submit() {
  if (busy.value || !config.value || !confirmed.value || !privacyConsent.value) return;
  if (!validateCurrentApplication()) { reviewing.value = false; await focusErrors(); return; }
  if (!token.value) { errors.value = { captcha: 'Complete the security check before submitting.' }; await focusErrors(); return; }
  busy.value = true; message.value = ''; errors.value = {};
  const body = new FormData();
  body.append('application', JSON.stringify({ ...data, periodId: config.value.periodId, privacyConsent: privacyConsent.value }));
  body.append('submissionId', submissionId.value);
  body.append('captchaToken', token.value);
  if (chosenFiles.value.length) {
    body.append('documents', JSON.stringify(chosenFiles.value.map(({ slot, file }) => ({ requirement: slot.key, contentType: file.type, size: file.size }))));
  }
  try {
    const response = await fetch('/api/enrollment/applications', { method: 'POST', body, signal: AbortSignal.timeout(45_000) });
    const result = await response.json();
    if (!response.ok) {
      message.value = result.message || 'Submission could not be completed. Please try again.';
      errors.value = result.errors ?? {};
      if (Object.keys(errors.value).some(key => !['captcha', 'privacyConsent'].includes(key))) reviewing.value = false;
      captcha.value?.reset(); token.value = '';
      await focusErrors();
      return;
    }
    if (!result.reference || result.status !== 'Pending') throw new Error();
    const pending: Record<string, PendingFile> = Object.fromEntries(chosenFiles.value.map(({ slot, file }) => [slot.key, { label: slot.label, file }]));
    receipt.value = result;
    uploadsUnavailable.value = result.uploadsUnavailable === true && Object.keys(pending).length > 0;
    const tickets: UploadTicket[] = Array.isArray(result.uploads) ? result.uploads : [];
    // Keep the receipt, discard personal details after confirmed persistence.
    Object.keys(data).forEach(key => delete data[key]);
    await nextTick(); receiptHeading.value?.focus();
    if (tickets.length) await uploadDocuments(tickets, pending);
    else Object.keys(files).forEach(key => delete files[key]);
  } catch {
    message.value = 'We could not confirm your submission. Keep this page open and retry with a new security check; your reference will be reused if it was already saved.';
    captcha.value?.reset(); token.value = ''; await focusErrors();
  } finally { busy.value = false; }
}
</script>

<template>
  <section class="enrollment-hero">
    <div class="container">
      <p class="eyebrow">Admissions · Pre-school, Elementary, Junior & Senior High School</p>
      <h1>Start your next chapter.</h1>
      <p>Apply to Sto. Niño Catholic School. Complete your details, review your application, and take the next step with our Registrar.</p>
    </div>
  </section>
  <section class="container enrollment-layout">
    <aside class="enrollment-aside">
      <p class="eyebrow">Online application</p>
      <h2>A place to grow.</h2>
      <ol class="enrollment-steps" aria-label="Application steps">
        <li :aria-current="!reviewing && !receipt ? 'step' : undefined"><span>01</span> Complete your details</li>
        <li :aria-current="reviewing && !receipt ? 'step' : undefined"><span>02</span> Review & submit</li>
        <li :aria-current="receipt ? 'step' : undefined"><span>03</span> Visit the Registrar</li>
      </ol>
      <div class="enrollment-note">
        <strong>Before you begin</strong>
        <p>Have the student’s personal details, parent or guardian contacts, and previous-school information ready.</p>
        <p>Submitting an application does not complete enrollment. The Registrar will verify your details in person.</p>
      </div>
      <RouterLink class="text-link" to="/contact">Need help? Contact the school →</RouterLink>
    </aside>
    <div class="enrollment-main">
      <p v-if="loading" class="enrollment-notice" role="status">Checking enrollment availability…</p>
      <div v-else-if="!config" class="enrollment-notice" role="alert">
        <h2>We’ll be right back</h2><p>{{ message }}</p>
        <button class="button button-secondary" @click="loadConfig">Try again</button>
      </div>
      <div v-else-if="receipt" class="enrollment-receipt">
        <p class="eyebrow">Application received</p>
        <h2 ref="receiptHeading" tabindex="-1">Thank you for applying.</h2>
        <p>Your application has been saved as <strong>{{ receipt.status }}</strong>.</p>
        <p class="receipt-label">Your reference number</p>
        <strong class="receipt-reference">{{ receipt.reference }}</strong>
        <p>Save or take a screenshot of this reference number.</p>
        <p>{{ receipt.message }}</p>
        <div v-if="Object.keys(uploads).length" class="upload-results" aria-live="polite">
          <h3>Uploaded documents</h3>
          <p v-if="uploadsBusy" class="upload-note">Keep this page open while your documents upload.</p>
          <ul>
            <li v-for="(entry, key) in uploads" :key="key" :class="['upload-result', entry.state]">
              <span class="upload-name">{{ entry.label }}</span>
              <span class="upload-state">{{ uploadLabels[entry.state] }}</span>
              <small v-if="entry.message">{{ entry.message }} Bring this document to the Registrar’s Office.</small>
            </li>
          </ul>
          <p v-if="!uploadsBusy" class="upload-note">Bring the original documents when you visit the Registrar’s Office so they can be verified.</p>
        </div>
        <p v-else-if="uploadsUnavailable" class="upload-note" role="status">Online uploads aren’t available right now. Bring your documents to the Registrar’s Office.</p>
        <RouterLink class="button button-secondary" to="/contact">Registrar contact details</RouterLink>
      </div>
      <div v-else-if="config.status === 'closed'" class="enrollment-notice" role="status">
        <h2>Enrollment is currently closed</h2>
        <p>Please contact the school for the next application period.</p>
        <RouterLink class="text-link" to="/contact">Contact the school →</RouterLink>
      </div>
      <form v-else class="enrollment-form" novalidate @submit.prevent="reviewing ? submit() : review()">
        <div class="form-intro">
          <span class="enrollment-badge">Enrollment open · {{ config.schoolYear }}</span>
          <h2 ref="reviewHeading" tabindex="-1">{{ reviewing ? 'Review your application' : 'Enrollment application' }}</h2>
          <p>{{ reviewing ? 'Check your details carefully before submitting.' : 'Fields marked * are required. Other fields may be left blank if not applicable.' }}</p>
        </div>
        <div v-if="message || Object.keys(errors).length" ref="errorSummary" class="form-error-summary" role="alert" tabindex="-1">
          <strong>{{ message || 'Please correct the following fields.' }}</strong>
          <ul v-if="Object.keys(errors).length">
            <li v-for="(error, key) in errors" :key="key"><a :href="`#${key}`">{{ error }}</a></li>
          </ul>
        </div>
        <template v-if="!reviewing">
          <fieldset v-for="(section, index) in sections" :key="section.title" class="form-section">
            <legend><span>{{ String(index + 1).padStart(2, '0') }}</span> {{ section.title }}</legend>
            <p>{{ section.description }}</p>
            <div class="form-grid">
              <div v-for="field in section.fields" :key="field.key" class="form-field" :class="{ 'field-wide': field.type === 'textarea' }">
                <label :for="field.key">{{ field.label }} <span v-if="field.required" aria-hidden="true">*</span></label>
                <select v-if="field.type === 'select'" :id="field.key" v-model="data[field.key]" :required="field.required" :aria-invalid="!!errors[field.key]" :aria-describedby="`${field.key}-help`" @blur="validateField(field.key)" @change="revalidateField(field.key)">
                  <option value="" disabled>Select {{ field.label.toLowerCase() }}</option>
                  <option v-for="option in field.options" :key="option" :value="option">{{ field.key === 'level' ? schoolLevels[option]?.label : option }}</option>
                </select>
                <textarea v-else-if="field.type === 'textarea'" :id="field.key" v-model="data[field.key]" :required="field.required" :maxlength="field.maxLength" rows="2" :aria-invalid="!!errors[field.key]" :aria-describedby="`${field.key}-help`" @blur="validateField(field.key)" @input="revalidateField(field.key)"></textarea>
                <input v-else :id="field.key" v-model="data[field.key]" :type="field.type ?? 'text'" :required="field.required" :readonly="field.readOnly" :max="field.type === 'date' ? todayInManila() : field.type === 'number' ? 120 : undefined" :min="field.type === 'number' ? 0 : undefined" :maxlength="field.maxLength" :pattern="field.pattern" :inputmode="field.inputMode" :aria-invalid="!!errors[field.key]" :aria-describedby="`${field.key}-help`" @blur="validateField(field.key)" @input="revalidateField(field.key)" />
                <small :id="`${field.key}-help`" :class="{ 'field-error': errors[field.key] }">{{ errors[field.key] || field.hint }}</small>
              </div>
            </div>
          </fieldset>
          <fieldset v-if="slots.length" class="form-section upload-section">
            <legend><span>{{ String(sections.length + 1).padStart(2, '0') }}</span> Upload documents <small>(optional)</small></legend>
            <p>Upload a clear scan or photo of any document you already have: PDF, JPG or PNG, up to 10 MB each. You can skip this and bring the documents to the Registrar’s Office instead. Either way, bring the originals for verification.</p>
            <ul class="upload-slots">
              <li v-for="slot in slots" :key="slot.key" class="upload-slot">
                <div class="upload-slot-text">
                  <label :for="`file-${slot.key}`">{{ slot.label }}</label>
                  <small v-if="files[slot.key]">{{ files[slot.key].name }} ({{ formatFileSize(files[slot.key].size) }})</small>
                  <small v-else-if="fileErrors[slot.key]" class="field-error">{{ fileErrors[slot.key] }}</small>
                  <small v-else>No file chosen</small>
                </div>
                <div class="upload-slot-actions">
                  <label class="button button-edit upload-pick" :for="`file-${slot.key}`">{{ files[slot.key] ? 'Replace' : 'Choose file' }}</label>
                  <input :id="`file-${slot.key}`" class="upload-input" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" @change="chooseFile(slot.key, $event)" />
                  <button v-if="files[slot.key]" type="button" class="button button-edit" @click="removeFile(slot.key)">Remove</button>
                </div>
              </li>
            </ul>
          </fieldset>
          <div class="form-actions"><p>Your details are used to process this application.</p><button class="button button-secondary" type="submit">Review application →</button></div>
        </template>
        <template v-else>
          <div v-for="section in sections" :key="section.title" class="review-section">
            <h3>{{ section.title }}</h3>
            <dl><template v-for="field in section.fields" :key="field.key"><div><dt>{{ field.label }}</dt><dd>{{ (field.key === 'level' ? schoolLevels[data[field.key]]?.label : data[field.key]) || 'Not provided' }}</dd></div></template></dl>
          </div>
          <div v-if="slots.length" class="review-section">
            <h3>Documents to upload</h3>
            <ul v-if="chosenFiles.length" class="review-files">
              <li v-for="{ slot, file } in chosenFiles" :key="slot.key"><strong>{{ slot.label }}</strong>: {{ file.name }} ({{ formatFileSize(file.size) }})</li>
            </ul>
            <p v-else class="review-files-none">None. You’ll bring your documents to the Registrar’s Office.</p>
          </div>
          <label class="confirmation-check"><input id="confirmation" v-model="confirmed" type="checkbox" :disabled="busy" /> I confirm that the details are accurate and understand that I must visit the Registrar’s Office to continue enrollment.</label>
          <label class="confirmation-check"><input id="privacyConsent" v-model="privacyConsent" type="checkbox" :disabled="busy" :aria-invalid="!!errors.privacyConsent" /> I consent to Sto. Niño Catholic School collecting and using the personal information and documents I provide to process this enrollment application.</label>
          <div id="captcha" class="captcha-area"><EnrollmentCaptcha ref="captcha" :site-key="config.siteKey" @token="token = $event" /></div>
          <div class="form-actions">
            <button type="button" class="button button-edit" :disabled="busy" @click="edit">← Edit details</button>
            <button type="submit" class="button button-secondary" :disabled="busy || !confirmed || !privacyConsent || !token">{{ busy ? 'Submitting…' : 'Submit application' }}</button>
          </div>
          <p v-if="busy" role="status">Please wait while we save your application.</p>
          <p v-if="chosenFiles.length && !busy" class="upload-note">Your documents upload right after the application is saved.</p>
        </template>
      </form>
    </div>
  </section>
</template>

<style scoped>
.enrollment-hero { padding: 4.5rem 0; background: var(--cream-100); border-bottom: 1px solid var(--line); }
.enrollment-hero h1 { max-width: 850px; font-size: clamp(2.6rem, 5vw, 4.5rem); color: var(--red-900); }
.enrollment-hero p:last-child { max-width: 650px; color: var(--muted); font-size: 1.1rem; margin-bottom: 0; }
.enrollment-layout { display: grid; grid-template-columns: 270px minmax(0, 1fr); gap: 3rem; padding-block: 3rem 6rem; align-items: start; }
.enrollment-aside { position: sticky; top: 110px; }
.enrollment-aside h2 { font-size: 1.9rem; }
.enrollment-steps { padding: 0; list-style: none; display: grid; gap: 1.4rem; margin: 2rem 0; }
.enrollment-steps li { display: flex; gap: .9rem; align-items: center; font-size: .9rem; color: var(--muted); }
.enrollment-steps span { padding: .6rem; background: #f1e7db; font-weight: 700; }
.enrollment-steps [aria-current] { font-weight: 700; color: var(--red-800); }
.enrollment-steps [aria-current] span { background: var(--red-800); color: white; }
.enrollment-note { border-top: 2px solid var(--gold-500); padding-top: 1.2rem; margin-bottom: 1.5rem; }
.enrollment-note p, .enrollment-aside .text-link { font-size: .9rem; }
.enrollment-note p { color: var(--muted); }
.enrollment-form, .enrollment-notice, .enrollment-receipt { background: white; border: 1px solid var(--line); padding: clamp(1.2rem, 3vw, 2.5rem); }
.enrollment-main h2 { font-size: clamp(1.6rem, 3vw, 2.1rem); margin: 1.2rem 0 .6rem; }
.enrollment-badge { display: inline-block; padding: .4rem .65rem; background: #eff5eb; color: #365624; font-size: .8rem; font-weight: 700; }
.form-intro p, .form-section > p { color: var(--muted); font-size: .9rem; }
.form-section { margin: 2rem 0 0; padding: 1.4rem 0; border: 0; border-top: 1px solid var(--line); min-width: 0; }
.form-section legend { padding: 0 .8rem 0 0; font-size: 1.05rem; font-weight: 700; }
.form-section legend span { color: var(--red-700); margin-right: .5rem; font-size: .8rem; }
.form-section legend small { font-weight: 400; }
.form-section > p { margin-top: 0; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem 1.2rem; }
.form-field { display: flex; flex-direction: column; gap: .45rem; }
.form-field label { font-size: .85rem; font-weight: 700; }
.form-field label span { color: var(--red-700); }
.form-field input, .form-field select, .form-field textarea { width: 100%; min-height: 44px; padding: .7rem; border: 1px solid #bcafa4; border-radius: 4px; background: white; color: var(--ink); font: inherit; font-size: .95rem; }
.form-field input[readonly] { background: #f5f2ed; }
.form-field small { font-size: .78rem; color: var(--muted); }
.field-wide { grid-column: 1 / -1; }
.enrollment-form :focus-visible { outline: 3px solid var(--gold-500); outline-offset: 3px; }
.form-field [aria-invalid=true] { border-color: #ad2116; }
.field-error, .form-field .field-error { color: #ad2116; }
.form-error-summary { padding: 1rem; border-left: 4px solid #ad2116; background: #fff0eb; margin-block: 1.5rem; scroll-margin-top: 110px; }
.form-error-summary li { margin-top: .5rem; }
.form-actions { display: flex; justify-content: space-between; align-items: center; gap: 1rem; border-top: 1px solid var(--line); padding-top: 1.5rem; margin-top: 1rem; }
.form-actions p { font-size: .8rem; color: var(--muted); max-width: 220px; }
.button { cursor: pointer; font: inherit; font-size: .9rem; font-weight: 700; }
.button:disabled { opacity: .55; cursor: not-allowed; }
.button-edit { background: white; color: var(--red-800); border-color: var(--line); }
.review-section { border-top: 1px solid var(--line); padding-top: 1.5rem; margin-top: 1.5rem; }
.review-section dl { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.review-section dt { color: var(--muted); font-size: .8rem; }
.review-section dd { margin: .25rem 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.confirmation-check { display: flex; align-items: flex-start; gap: .7rem; line-height: 1.6; margin: 2rem 0; font-size: .9rem; }
.confirmation-check input { flex: 0 0 18px; width: 18px; height: 18px; margin-top: .2rem; accent-color: var(--red-800); }
.captcha-area { min-height: 70px; }
.receipt-label { font-size: .85rem; color: var(--muted); margin: 2rem 0 .5rem; }
.receipt-reference { display: block; padding: 1rem; background: var(--cream-100); color: var(--red-800); overflow-wrap: anywhere; font-family: monospace; font-size: 1.15rem; }
.upload-section small { font-weight: 400; color: var(--muted); }
.upload-slots { display: grid; gap: .6rem; margin: 0; padding: 0; list-style: none; }
.upload-slot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .6rem 1rem; padding: .8rem 1rem; border: 1px solid var(--line); border-radius: 6px; background: var(--cream-50); }
.upload-slot-text { display: grid; gap: .2rem; min-width: 0; }
.upload-slot-text label { font-size: .9rem; font-weight: 700; }
.upload-slot-text small { overflow-wrap: anywhere; font-size: .8rem; color: var(--muted); }
.upload-slot-actions { display: flex; gap: .5rem; }
.upload-pick { min-height: 40px; padding: .5rem .9rem; }
.upload-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.upload-pick:has(+ .upload-input:focus-visible) { outline: 3px solid var(--gold-500); outline-offset: 3px; }
.review-files { margin: .5rem 0 0; padding-left: 1.2rem; font-size: .9rem; }
.review-files li { margin-top: .3rem; overflow-wrap: anywhere; }
.review-files-none, .upload-note { color: var(--muted); font-size: .9rem; }
.upload-results { margin: 1.5rem 0; padding: 1rem 1.2rem; border: 1px solid var(--line); background: var(--cream-50); }
.upload-results h3 { margin: 0 0 .4rem; font-size: 1.05rem; }
.upload-results ul { display: grid; gap: .5rem; margin: .6rem 0; padding: 0; list-style: none; }
.upload-result { display: grid; grid-template-columns: 1fr auto; gap: .2rem 1rem; font-size: .9rem; }
.upload-result small { grid-column: 1 / -1; color: #ad2116; }
.upload-state { font-weight: 700; color: var(--muted); }
.upload-result.done .upload-state { color: #2f6b2a; }
.upload-result.failed .upload-state { color: #ad2116; }
@media (max-width: 1000px) { .enrollment-layout { grid-template-columns: 220px minmax(0, 1fr); gap: 1.5rem; } }
@media (max-width: 760px) { .enrollment-layout { grid-template-columns: 1fr; } .enrollment-aside { position: static; } .enrollment-note { display: none; } .enrollment-steps { gap: .8rem; } }
@media (max-width: 480px) { .form-grid, .review-section dl { grid-template-columns: 1fr; } .form-actions { flex-direction: column; align-items: stretch; } .enrollment-hero { padding: 3rem 0; } }
</style>
