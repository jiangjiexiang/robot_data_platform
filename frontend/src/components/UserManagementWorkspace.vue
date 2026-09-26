<template>
  <main class="user-workspace">
    <section class="user-heading">
      <div>
        <p>账号管理</p>
        <h1>账号与权限</h1>
      </div>
      <button class="refresh-button" type="button" :disabled="loading" title="刷新账号列表" @click="loadUsers">刷新</button>
    </section>

    <p v-if="notice" :class="['notice', notice.kind]" role="status">{{ notice.text }}</p>

    <section class="create-user" aria-label="新建账号">
      <div class="section-title"><h2>新建账号</h2></div>
      <form class="create-form" @submit.prevent="createUser">
        <label><span>账号</span><input v-model.trim="draft.account" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_-]+" autocomplete="off" /></label>
        <label><span>名称</span><input v-model.trim="draft.name" required maxlength="48" autocomplete="name" /></label>
        <label><span>初始密码</span><input v-model="draft.password" required minlength="5" maxlength="128" type="password" autocomplete="new-password" /></label>
        <label><span>权限</span><select v-model="draft.role"><option value="viewer">查看</option><option value="operator">控制</option><option value="admin">管理员</option></select></label>
        <button class="create-button" type="submit" :disabled="creating">{{ creating ? "创建中" : "创建账号" }}</button>
      </form>
    </section>

    <section class="users-section" aria-label="账号列表">
      <div class="section-title"><h2>账号列表</h2><span>{{ users.length }} 个账号</span></div>
      <div v-if="loading" class="empty-state">正在加载</div>
      <div v-else-if="!users.length" class="empty-state">暂无账号</div>
      <div v-else class="users-table-wrap">
        <table class="users-table">
          <thead><tr><th>账号</th><th>名称</th><th>权限</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="user in users" :key="user.id">
              <td data-label="账号"><strong>{{ accountName(user.email) }}</strong><small v-if="user.id === currentUser?.id">当前账号</small></td>
              <td data-label="名称">{{ user.name }}</td>
              <td data-label="权限">
                <select :value="user.role" :disabled="savingId === user.id || (user.id === currentUser?.id && user.role === 'admin')" @change="changeRole(user, ($event.target as HTMLSelectElement).value)">
                  <option value="viewer">查看</option><option value="operator">控制</option><option value="admin">管理员</option>
                </select>
              </td>
              <td data-label="创建时间">{{ formatDate(user.createdAt) }}</td>
              <td data-label="操作" class="actions">
                <button type="button" :disabled="savingId === user.id" @click="openPasswordDialog(user)">重置密码</button>
                <button class="delete-button" type="button" :disabled="savingId === user.id || user.id === currentUser?.id" @click="deleteUser(user)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="passwordUser" class="password-overlay" role="dialog" aria-modal="true" aria-labelledby="password-dialog-title">
      <form class="password-dialog" @submit.prevent="resetPassword">
        <h2 id="password-dialog-title">重置密码</h2>
        <p>{{ accountName(passwordUser.email) }}</p>
        <label><span>新密码</span><input v-model="newPassword" required minlength="5" maxlength="128" type="password" autocomplete="new-password" autofocus /></label>
        <div class="dialog-actions"><button type="button" @click="closePasswordDialog">取消</button><button class="confirm-button" type="submit" :disabled="savingId === passwordUser.id">确认</button></div>
      </form>
    </div>
  </main>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";

type Role = "viewer" | "operator" | "admin";
type ManagedUser = { id: string; name: string; email: string; role: Role; createdAt: string };
type CurrentUser = { id?: string; name?: string; email?: string; role?: Role } | null;

const props = defineProps<{ currentUser: CurrentUser }>();
const users = ref<ManagedUser[]>([]);
const loading = ref(false);
const creating = ref(false);
const savingId = ref("");
const passwordUser = ref<ManagedUser | null>(null);
const newPassword = ref("");
const notice = ref<{ kind: "success" | "error"; text: string } | null>(null);
const draft = reactive({ account: "", name: "", password: "", role: "viewer" as Role });

function accountName(email: string): string {
  return email.endsWith("@robot.local") ? email.slice(0, -"@robot.local".length) : email;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

function showNotice(kind: "success" | "error", text: string) {
  notice.value = { kind, text };
}

async function request(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function loadUsers() {
  loading.value = true;
  try {
    const data = await request("/api/admin/users");
    users.value = data.users || [];
  } catch (error) {
    showNotice("error", error instanceof Error ? error.message : "加载账号失败");
  } finally {
    loading.value = false;
  }
}

async function createUser() {
  if (creating.value) return;
  creating.value = true;
  try {
    await request("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
    Object.assign(draft, { account: "", name: "", password: "", role: "viewer" });
    showNotice("success", "账号已创建");
    await loadUsers();
  } catch (error) {
    showNotice("error", error instanceof Error ? error.message : "创建账号失败");
  } finally {
    creating.value = false;
  }
}

async function changeRole(user: ManagedUser, role: string) {
  if (role === user.role || savingId.value) return;
  savingId.value = user.id;
  try {
    await request(`/api/admin/users/${encodeURIComponent(user.id)}/role`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
    user.role = role as Role;
    showNotice("success", "权限已更新");
  } catch (error) {
    showNotice("error", error instanceof Error ? error.message : "修改权限失败");
    await loadUsers();
  } finally {
    savingId.value = "";
  }
}

function openPasswordDialog(user: ManagedUser) {
  passwordUser.value = user;
  newPassword.value = "";
}

function closePasswordDialog() {
  passwordUser.value = null;
  newPassword.value = "";
}

async function resetPassword() {
  if (!passwordUser.value || savingId.value) return;
  const user = passwordUser.value;
  savingId.value = user.id;
  try {
    await request(`/api/admin/users/${encodeURIComponent(user.id)}/password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: newPassword.value }) });
    closePasswordDialog();
    showNotice("success", "密码已重置");
  } catch (error) {
    showNotice("error", error instanceof Error ? error.message : "密码重置失败");
  } finally {
    savingId.value = "";
  }
}

async function deleteUser(user: ManagedUser) {
  if (!window.confirm(`确认删除账号“${accountName(user.email)}”吗？`)) return;
  savingId.value = user.id;
  try {
    await request(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
    users.value = users.value.filter((item) => item.id !== user.id);
    showNotice("success", "账号已删除");
  } catch (error) {
    showNotice("error", error instanceof Error ? error.message : "删除账号失败");
  } finally {
    savingId.value = "";
  }
}

onMounted(() => { void loadUsers(); });
</script>

<style scoped>
.user-workspace { max-width: 1380px; margin: 0 auto; padding: 30px 40px 48px; color: #282a2d; }
.user-heading { display: flex; align-items: end; justify-content: space-between; gap: 18px; padding-bottom: 18px; border-bottom: 1px solid #dedfe0; }
.user-heading p { color: #4f5559; font-size: 14px; font-weight: 700; }.user-heading h1 { margin-top: 4px; font-size: 21px; }
.refresh-button, .actions button, .dialog-actions button { min-height: 34px; padding: 0 11px; border: 1px solid #cfd3d5; border-radius: 4px; background: #fff; color: #3e4245; cursor: pointer; font-size: 12px; font-weight: 650; }
.refresh-button:hover, .actions button:hover, .dialog-actions button:hover { border-color: #767c80; background: #f5f6f6; }.refresh-button:disabled, button:disabled { opacity: .5; cursor: default; }
.notice { margin-top: 16px; padding: 10px 12px; border: 1px solid; border-radius: 5px; font-size: 13px; }.notice.success { border-color: #b9dfcb; color: #236743; background: #f1faf5; }.notice.error { border-color: #e9c0c4; color: #a72f38; background: #fff5f5; }
.create-user, .users-section { margin-top: 18px; border: 1px solid #dedfe0; border-radius: 7px; background: #fff; box-shadow: 0 1px 3px rgba(22, 27, 29, .04); }
.section-title { display: flex; align-items: center; justify-content: space-between; min-height: 52px; padding: 0 18px; border-bottom: 1px solid #e5e6e7; }.section-title h2 { font-size: 15px; }.section-title span { color: #777c80; font-size: 12px; }
.create-form { display: grid; grid-template-columns: 1.1fr 1.2fr 1.2fr .8fr auto; gap: 12px; align-items: end; padding: 18px; }.create-form label, .password-dialog label { display: grid; gap: 7px; color: #52575b; font-size: 12px; font-weight: 650; }
input, select { width: 100%; min-height: 38px; padding: 0 10px; border: 1px solid #cfd3d5; border-radius: 4px; color: #292c2f; background: #fff; font: 13px ui-monospace, monospace; outline: none; } input:focus, select:focus { border-color: #398267; box-shadow: 0 0 0 3px rgba(57, 130, 103, .12); }
.create-button, .confirm-button { min-height: 38px; padding: 0 15px; border: 1px solid #267457; border-radius: 4px; background: #267457; color: #fff; cursor: pointer; font-size: 13px; font-weight: 700; }.create-button:disabled, .confirm-button:disabled { opacity: .55; cursor: default; }
.users-table-wrap { overflow-x: auto; }.users-table { width: 100%; border-collapse: collapse; min-width: 760px; }.users-table th, .users-table td { padding: 13px 18px; border-bottom: 1px solid #ececed; text-align: left; vertical-align: middle; font-size: 13px; }.users-table th { color: #73787c; background: #fafafa; font-size: 11px; font-weight: 700; }.users-table tbody tr:last-child td { border-bottom: 0; }.users-table td strong { display: block; font: 650 13px ui-monospace, monospace; }.users-table td small { display: block; margin-top: 4px; color: #378065; font-size: 10px; }.users-table td select { min-width: 92px; min-height: 32px; font-size: 12px; }.actions { display: flex; gap: 7px; white-space: nowrap; }.actions .delete-button { border-color: #e5bfc2; color: #b2343d; }.empty-state { padding: 35px 18px; color: #7b8084; text-align: center; font-size: 13px; }
.password-overlay { position: fixed; inset: 0; z-index: 1200; display: grid; place-items: center; padding: 20px; background: rgba(22, 25, 29, .52); }.password-dialog { width: min(370px, 100%); padding: 22px; border: 1px solid #dedfe0; border-radius: 7px; background: #fff; box-shadow: 0 18px 55px rgba(0, 0, 0, .2); }.password-dialog h2 { font-size: 18px; }.password-dialog > p { margin: 8px 0 20px; color: #6f7478; font: 12px ui-monospace, monospace; }.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
@media (max-width: 980px) { .user-workspace { padding: 24px; }.create-form { grid-template-columns: 1fr 1fr; }.create-button { width: max-content; } }
@media (max-width: 580px) { .user-workspace { padding: 16px 12px 32px; }.user-heading { padding-bottom: 14px; }.user-heading h1 { font-size: 19px; }.create-form { grid-template-columns: 1fr; gap: 13px; padding: 14px; }.create-button { width: 100%; }.users-table { min-width: 0; }.users-table thead { display: none; }.users-table, .users-table tbody, .users-table tr, .users-table td { display: block; width: 100%; }.users-table tr { padding: 10px 14px; border-bottom: 1px solid #e7e8e9; }.users-table td { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 8px; padding: 7px 0; border: 0; }.users-table td::before { content: attr(data-label); color: #7a7f83; font-size: 11px; font-weight: 700; }.users-table td.actions { display: flex; flex-wrap: wrap; padding-left: 84px; }.users-table td.actions::before { display: none; } }
</style>
