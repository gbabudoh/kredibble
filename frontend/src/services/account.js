// Account API client. The session lives in an httpOnly cookie set by the server, so this
// code never sees or stores a token. Only identity and plan data travel here, never chats.

const BASE = "/api/v1/account";

export class AccountError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** FastAPI errors are a string, or a list of validation errors for 422. */
function errorMessage(detail, status) {
  if (typeof detail === "string") return detail;
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

async function request(path, body) {
  let response;
  try {
    response = await fetch(`${BASE}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new AccountError("Could not reach the server. Check your connection.", 0);
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new AccountError(errorMessage(data.detail, response.status), response.status);
  return data;
}

export const AccountAPI = {
  /** {enabled, account}. Never throws: offline or no server means "accounts unavailable". */
  async session() {
    try {
      return await request("me");
    } catch {
      return { enabled: false, account: null };
    }
  },
  register: (fields) => request("register", fields),
  login: (email, password) => request("login", { email, password }),
  logout: () => request("logout", {}),
  update: (fields) => request("me", fields),
  verifyEmail: (token) => request("verify-email", { token }),
  resendVerification: () => request("resend-verification", {}),
  forgotPassword: (email) => request("forgot-password", { email }),
  resetPassword: (token, password) => request("reset-password", { token, password }),
  deleteAccount: (password) => request("delete", { password }),
};
