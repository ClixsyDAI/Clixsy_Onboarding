"use client";

// =============================================================
// /admin/login — Phase 9 emergency hotfix admin login page
// =============================================================
//
// Minimal sign-in UI. Password input + submit. On success the
// server sets the admin_token cookie (HttpOnly) and we
// router.replace to /admin/onboarding/sessions (per pre-work
// decision 4).
//
// No return-URL handling in this emergency PR — the universal
// landing target is the sessions list. Slack /admin/onboarding/
// sessions/<id> deep links will land on the list after sign-in
// and the AM clicks through; if Slack-link friction is real,
// add ?return= handling in a follow-up modelled on the
// workbook's app/lib/return-url.ts.
//
// Styling mirrors the dark Clixsy theme used on the workbook
// admin page and the existing onboarding admin pages — same
// CLIXSY logo, same accent colour (#C8A882), same panel
// treatment.

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";

const CLIXSY_LOGO_URL =
  "https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg";

export default function AdminLoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // Cookie is set by the response. Redirect to the
        // canonical landing target — the sessions list.
        router.replace("/admin/onboarding/sessions");
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(
        typeof data?.error === "string" ? data.error : "Sign in failed",
      );
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ backgroundColor: "#0a0a0a" }}
    >
      <div
        className="w-full max-w-sm rounded-sm border p-8"
        style={{ backgroundColor: "#111111", borderColor: "#1a1a1a" }}
      >
        <div className="mb-6 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={CLIXSY_LOGO_URL}
            alt="CLIXSY"
            className="h-7 w-auto"
          />
          <span
            className="text-xs tracking-wider uppercase"
            style={{ color: "#888" }}
          >
            Onboarding admin
          </span>
        </div>
        <h1
          className="mb-1 text-lg font-bold tracking-wide uppercase"
          style={{ color: "#f0ede8" }}
        >
          Sign in
        </h1>
        <p className="mb-6 text-xs" style={{ color: "#888" }}>
          Enter the admin password to access onboarding sessions.
        </p>
        <form onSubmit={onSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            disabled={loading}
            className="mb-3 w-full rounded-sm border px-4 py-2.5 text-sm outline-none transition-colors focus:border-[#C8A882]"
            style={{
              backgroundColor: "#0a0a0a",
              borderColor: "#333",
              color: "#f0ede8",
            }}
          />
          {error && (
            <p className="mb-3 text-xs" style={{ color: "#e06666" }}>
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading || password.length === 0}
            className="w-full rounded-sm py-2.5 text-sm font-semibold tracking-wide uppercase transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ backgroundColor: "#C8A882", color: "#0a0a0a" }}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
