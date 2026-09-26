<template>
  <main class="auth-page">
    <form class="auth-form" @submit.prevent="submit">
      <header>
        <p>机械臂控制</p>
        <h1>登录控制台</h1>
      </header>
      <label>
        <span>账号</span>
        <input v-model.trim="account" autocomplete="username" required maxlength="80" />
      </label>
      <label>
        <span>密码</span>
        <input v-model="password" type="password" autocomplete="current-password" required minlength="5" maxlength="128" />
      </label>
      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
      <button :disabled="submitting" type="submit">{{ submitting ? "处理中" : "登录" }}</button>
    </form>
  </main>
</template>

<script setup lang="ts">
import { ref } from "vue";

const emit = defineEmits<{ authenticated: [] }>();
const submitting = ref(false);
const error = ref("");
const account = ref("admin");
const password = ref("");

async function submit() {
  if (submitting.value) return;
  error.value = "";
  submitting.value = true;
  try {
    const normalizedAccount = account.value.includes("@")
      ? account.value
      : `${account.value}@robot.local`;
    const response = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: normalizedAccount, password: password.value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || "登录失败");
    emit("authenticated");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "登录失败";
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.auth-page { min-height: 100vh; display: grid; place-items: center; padding: 20px; background: #eef1f1; color: #272a2c; }
.auth-form { width: min(390px, 100%); display: grid; gap: 16px; padding: 28px; border: 1px solid #d8dcdd; border-radius: 7px; background: #fff; box-shadow: 0 12px 32px rgba(22, 27, 29, .12); }
header p { color: #2e8c69; font: 700 11px ui-monospace, monospace; }
header h1 { margin-top: 6px; font-size: 22px; }
label { display: grid; gap: 7px; color: #555a5d; font-size: 12px; font-weight: 650; }
input { width: 100%; min-height: 42px; padding: 0 11px; border: 1px solid #cdd2d3; border-radius: 5px; color: #25282a; font: 14px ui-monospace, monospace; outline: none; }
input:focus { border-color: #2e8c69; box-shadow: 0 0 0 3px rgba(46, 140, 105, .12); }
button { min-height: 44px; border: 1px solid #246f54; border-radius: 5px; background: #246f54; color: #fff; cursor: pointer; font-size: 14px; font-weight: 700; }
button:disabled { cursor: default; opacity: .55; }
.auth-error { padding: 10px; border: 1px solid #efc6c9; border-radius: 5px; color: #af3440; background: #fff4f5; font-size: 12px; line-height: 1.4; }
</style>
