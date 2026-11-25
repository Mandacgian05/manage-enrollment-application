<!--
  Temporary access (PB-05 / US-14): a Super Admin lends one privilege to another Admin until an
  end date, with a reason. The database refuses grants to oneself, checks every rule again and
  writes each grant and revocation to the audit log.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { getStaffSupabaseClient } from "@/lib/supabase";

type Privilege = "manageStaffAccounts" | "manageContent";
type AdminAccount = { userId: string; firstName: string; lastName: string; email: string; role: string; adminType: string | null; status: string };
type Grant = {
  grantId: string; userId: string; staffName: string; email: string; privilege: Privilege; reason: string;
  expiresAt: string; grantedAt: string; grantedByName: string; revokedAt: string | null; active: boolean;
};

const privileges: Record<Privilege, string> = { manageStaffAccounts: "Create staff accounts", manageContent: "Manage website content" };
// What each kind of Admin can borrow: the access its own role does not already give.
const lendable: Record<string, Privilege[]> = { accountAdmin: ["manageContent"], contentAdmin: ["manageStaffAccounts"] };

const client = getStaffSupabaseClient();
const admins = ref<AdminAccount[]>([]);
const grants = ref<Grant[]>([]);
const loading = ref(true);
const saving = ref(false);
const listError = ref("");
const formError = ref("");
const notice = ref("");
const confirmRevoke = ref<string>();
const userId = ref("");
const privilege = ref<Privilege | "">("");
const endDate = ref("");
const reason = ref("");

const manilaDay = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(Date.now() + offsetDays * 864e5));
const today = manilaDay();
const lastDay = manilaDay(365);
const whenFormat = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
});
const formatWhen = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : whenFormat.format(date);
};
const isGrant = (row: unknown): row is Grant => Boolean(row) && typeof row === "object"
  && typeof (row as Grant).grantId === "string" && (row as Grant).privilege in privileges
  && typeof (row as Grant).expiresAt === "string" && typeof (row as Grant).active === "boolean";
const adminName = (account: AdminAccount) => `${account.firstName} ${account.lastName}`;
const selected = computed(() => admins.value.find((account) => account.userId === userId.value));
const options = computed(() => (selected.value?.adminType && lendable[selected.value.adminType]) || []);
watch(options, (list) => { privilege.value = list.length === 1 ? list[0] : ""; });

async function load() {
  loading.value = true;
  listError.value = "";
  try {
    const [accounts, list] = await Promise.all([client.rpc("list_staff_accounts", { p_offset: 0 }), client.rpc("list_privilege_grants")]);
    if (accounts.error || list.error) throw new Error();
    admins.value = (Array.isArray(accounts.data) ? accounts.data as AdminAccount[] : [])
      .filter((account) => account?.status === "active" && Boolean(account.adminType) && account.adminType! in lendable);
    grants.value = Array.isArray(list.data) ? list.data.filter(isGrant) : [];
  } catch {
    listError.value = "Temporary access could not be loaded. Please try again.";
  } finally {
    loading.value = false;
  }
}

async function give() {
  formError.value = "";
  notice.value = "";
  if (!selected.value || !privilege.value) { formError.value = "Choose an Admin and the access to give."; return; }
  if (!endDate.value || endDate.value < today) { formError.value = "Choose an end date from today onwards."; return; }
  if (reason.value.trim().length < 5) { formError.value = "Give a reason of at least 5 characters."; return; }
  saving.value = true;
  try {
    // Access lasts until 11:59 PM, Philippine time, on the end date.
    const { data, error } = await client.rpc("grant_privilege", {
      p_user_id: Number(selected.value.userId), p_privilege: privilege.value,
      p_expires_at: `${endDate.value}T23:59:00+08:00`, p_reason: reason.value.trim(),
    });
    if (error) throw new Error(error.message);
    if (data?.granted === false) throw new Error(data.message);
    notice.value = `${adminName(selected.value)} can ${privileges[privilege.value].toLowerCase()} until ${formatWhen(`${endDate.value}T23:59:00+08:00`)}.`;
    userId.value = "";
    endDate.value = "";
    reason.value = "";
    await load();
  } catch (issue) {
    formError.value = issue instanceof Error && issue.message ? issue.message : "Temporary access could not be given.";
  } finally {
    saving.value = false;
  }
}

async function revoke(grant: Grant) {
  formError.value = "";
  notice.value = "";
  saving.value = true;
  try {
    const { data, error } = await client.rpc("revoke_privilege", { p_grant_id: Number(grant.grantId) });
    if (error) throw new Error(error.message);
    if (data?.revoked === false) throw new Error(data.message);
    notice.value = `${grant.staffName}'s temporary access was revoked.`;
    confirmRevoke.value = undefined;
    await load();
  } catch (issue) {
    formError.value = issue instanceof Error && issue.message ? issue.message : "Temporary access could not be revoked.";
  } finally {
    saving.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section class="grants" aria-labelledby="temporary-access-heading">
    <div class="grant-card">
      <h2 id="temporary-access-heading" tabindex="-1">Temporary access</h2>
      <p class="grant-hint">Lend an Admin one more kind of access until an end date, for example while a colleague is away. It stops by itself after that date.</p>
      <p v-if="loading" role="status">Loading temporary access…</p>
      <template v-else-if="listError">
        <p class="grant-error" role="alert">{{ listError }}</p>
        <button type="button" @click="load">Try again</button>
      </template>
      <template v-else>
        <form class="grant-form" @submit.prevent="give">
          <label>Admin
            <select v-model="userId" required>
              <option value="" disabled>Choose an Admin</option>
              <option v-for="account in admins" :key="account.userId" :value="account.userId">{{ adminName(account) }}</option>
            </select>
          </label>
          <label>Access
            <select v-model="privilege" required :disabled="!options.length">
              <option v-for="option in options" :key="option" :value="option">{{ privileges[option] }}</option>
            </select>
          </label>
          <label>Ends on
            <input v-model="endDate" type="date" required :min="today" :max="lastDay" />
          </label>
          <label class="grant-reason">Reason
            <input v-model="reason" type="text" required minlength="5" maxlength="300" placeholder="e.g. Covering for Jan while on leave" />
          </label>
          <button class="grant-primary" type="submit" :disabled="saving">Give access</button>
        </form>
        <p v-if="!admins.length" class="grant-hint">Create an Account Admin or Content Admin first.</p>
        <p v-if="formError" class="grant-error" role="alert">{{ formError }}</p>
        <p v-if="notice" class="grant-success" role="status">{{ notice }}</p>
      </template>
    </div>

    <div v-if="!loading && !listError" class="grant-card grant-list-card">
      <h3>History</h3>
      <p v-if="!grants.length" class="grant-hint">No temporary access has been given yet.</p>
      <div v-else class="grant-table">
        <table aria-label="Temporary access history">
          <thead><tr><th scope="col">Admin</th><th scope="col">Access</th><th scope="col">Reason</th><th scope="col">Ends</th><th scope="col">Given by</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
          <tbody>
            <tr v-for="grant in grants" :key="grant.grantId">
              <th scope="row">{{ grant.staffName }}</th>
              <td>{{ privileges[grant.privilege] }}</td>
              <td>{{ grant.reason }}</td>
              <td>{{ formatWhen(grant.expiresAt) }}</td>
              <td>{{ grant.grantedByName }}<small>{{ formatWhen(grant.grantedAt) }}</small></td>
              <td><span class="grant-status" :data-status="grant.active ? 'active' : 'ended'">{{ grant.active ? "Active" : grant.revokedAt ? "Revoked" : "Ended" }}</span></td>
              <td class="grant-actions">
                <template v-if="grant.active && confirmRevoke === grant.grantId">
                  <button type="button" :disabled="saving" @click="revoke(grant)">Confirm</button>
                  <button type="button" :disabled="saving" @click="confirmRevoke = undefined">Cancel</button>
                </template>
                <button v-else-if="grant.active" type="button" :disabled="saving" @click="confirmRevoke = grant.grantId">Revoke</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Same cards as the staff accounts panel. */
.grant-card { margin: 0 0 1.1rem; padding: 1.1rem 1.2rem 1.2rem; border: 1px solid #ece3e1; border-radius: 13px; background: #fff; box-shadow: 0 2px 8px #3f191605; }
.grant-card h2 { margin: 0; font-size: 1.35rem; letter-spacing: -.02em; }
.grant-card h2:focus { outline: none; }
.grant-card h3 { margin: 0; font-size: 1.15rem; letter-spacing: -.02em; }
.grant-card > p { margin: .8rem 0 0; }
.grant-hint { margin: .3rem 0 0; color: #665b60; font-size: .88rem; }
.grant-form { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: end; gap: .7rem; margin: 1rem 0 0; }
.grant-reason { grid-column: 1 / 3; }
label { display: grid; gap: .35rem; min-width: 0; font-size: .85rem; font-weight: 700; }
input, select { width: 100%; min-height: 42px; border: 1px solid #817078; border-radius: 8px; padding: .45rem .6rem; background: #fff; font: inherit; font-weight: 400; }
button { min-height: 36px; padding: .35rem .75rem; border: 1px solid #dfd2d1; border-radius: 8px; background: #fff; color: #4f323a; font: inherit; font-size: .85rem; font-weight: 700; cursor: pointer; }
button:hover:not(:disabled) { background: #f5ecec; }
button:disabled { opacity: .6; cursor: default; }
.grant-primary { min-height: 42px; border-color: var(--red-700); background: var(--red-700); color: #fff; }
.grant-primary:hover:not(:disabled) { background: var(--red-800); }
:focus-visible { outline: 2px solid #245d96; outline-offset: 2px; }
.grant-error, .grant-success { padding: .6rem .8rem; border-radius: 8px; font-weight: 700; }
.grant-error { background: #fde3df; color: var(--red-800); }
.grant-success { background: #e7f4eb; color: #28654e; }
.grant-list-card { padding-inline: 0; padding-bottom: .3rem; }
.grant-list-card > h3, .grant-list-card > p { margin-inline: 1.2rem; }
.grant-list-card > p { margin-block: .6rem 1rem; }
.grant-table { margin-top: 1rem; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: #fff; }
th, td { border-top: 1px solid #ece3e1; padding: .75rem 1.2rem; text-align: left; vertical-align: top; font-size: .9rem; }
thead th { background: #fbf7f6; color: #665b60; font-size: .76rem; }
td small { display: block; color: #665b60; font-size: .78rem; }
.grant-status { display: inline-block; padding: .15rem .55rem; border-radius: 999px; background: #f0e9ed; color: #66515c; font-size: .76rem; font-weight: 700; }
.grant-status[data-status="active"] { background: #e7f4eb; color: #28654e; }
.grant-actions button { margin: .2rem; }

@media (max-width: 960px) { .grant-form { grid-template-columns: 1fr 1fr; } .grant-reason { grid-column: 1 / -1; } }
@media (max-width: 540px) { .grant-form { grid-template-columns: 1fr; } }
</style>
