// Account and usage API client. The session lives in an httpOnly cookie set by the server, so this
// code never sees or stores a token. Only identity and plan data travel here, never chats.

const BASE = "/api/v1";

export class AccountError extends Error {
  constructor(message, status, detail = null) {
    super(message);
    this.status = status;
    this.detail = detail; // structured error body, e.g. {used, limit} for the daily limit
  }
}

/** FastAPI errors are a string, or a list of validation errors for 422. */
function errorMessage(detail, status) {
  if (typeof detail === "string") return detail;
  if (detail?.message) return detail.message;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0];
    const field = first.loc?.[first.loc.length - 1];
    const msg = String(first.msg || "Invalid value").replace(/^Value error, /, "");
    if (field === "email") return "Enter a valid email address.";
    if (field === "password") return `Password: ${msg}`;
    return msg;
  }
  return status === 503 ? "Accounts are not available on this server." : "Something went wrong. Please try again.";
}

async function request(path, body, { timeoutMs = 15000 } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AccountError("Could not reach the server. Check your connection.", 0);
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new AccountError(errorMessage(data.detail, response.status), response.status, data.detail);
  return data;
}

export const AccountAPI = {
  /**
   * {enabled, account, entitlements, messages_used_today}. Never throws: offline or no server
   * means "accounts unavailable", and the app runs without plan limits.
   */
  async session(timeZone) {
    try {
      return await request(`account/me${timeZone ? `?tz=${encodeURIComponent(timeZone)}` : ""}`, undefined, { timeoutMs: 5000 });
    } catch {
      return { enabled: false, account: null, entitlements: null, messages_used_today: 0 };
    }
  },
  register: (fields) => request("account/register", fields),
  login: (email, password) => request("account/login", { email, password }),
  logout: () => request("account/logout", {}),
  update: (fields) => request("account/me", fields),
  verifyEmail: (token) => request("account/verify-email", { token }),
  resendVerification: () => request("account/resend-verification", {}),
  forgotPassword: (email) => request("account/forgot-password", { email }),
  resetPassword: (token, password) => request("account/reset-password", { token, password }),
  deleteAccount: (password) => request("account/delete", { password }),
  /** Takes one of today's messages: {used, limit}, or AccountError 429 with detail {used, limit}. */
  useMessage: (timeZone) => request("usage/message", { timezone: timeZone }, { timeoutMs: 5000 }),
};
