/* Minimal functional login gate for the Amber Pay monitor.
   Flow: email + password → backend returns a 2FA challenge → a 6-digit code
   field appears → on success the token is stored and the dashboard loads.

   This is a NEW surface but stays visually consistent with the Midnight
   Transit Diagonal theme by reusing the CSS custom properties from
   global.css/dashboard.css via inline styles. No new design system. */

import { useState } from "react";
import type { FormEvent } from "react";
import { login } from "./client";
import { verifyAndStoreToken } from "./auth";

const fieldStyle: React.CSSProperties = {
  width: "100%",
  font: "inherit",
  fontSize: "0.85rem",
  padding: "0.5rem 0.6rem",
  border: "1px solid var(--rule-enamel)",
  borderRadius: "var(--radius)",
  background: "var(--midnight-2)",
  color: "var(--porcelain)",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--porcelain-faint)",
  marginBottom: "0.25rem",
};

const inputRowStyle: React.CSSProperties = {
  marginBottom: "0.8rem",
};

const errorStyle: React.CSSProperties = {
  color: "var(--text-suspended)",
  fontSize: "0.78rem",
  marginTop: "0.6rem",
};

export function LoginGate({
  onAuthenticated,
}: {
  onAuthenticated: (token: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { challengeId: id } = await login(email, password);
      setChallengeId(id);
    } catch {
      setError("Sign-in failed. Check your email and password.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCodeSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (!challengeId) return;
      // Password was already sent once during login; only the code + challenge
      // are sent here (m2).
      const token = await verifyAndStoreToken(challengeId, code);
      onAuthenticated(token);
    } catch {
      setError("Verification failed. Check the 6-digit code.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--midnight)",
        color: "var(--porcelain)",
        padding: "1rem",
      }}
    >
      <form
        onSubmit={challengeId ? handleCodeSubmit : handlePasswordSubmit}
        style={{
          width: "100%",
          maxWidth: "340px",
          border: "1px solid var(--rule-enamel)",
          borderRadius: "var(--radius)",
          background: "var(--midnight-2)",
          boxShadow: "var(--shadow-panel)",
          padding: "1.4rem",
        }}
      >
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontWeight: 600, fontSize: "1rem" }}>Amber Pay</div>
          <div style={{ color: "var(--porcelain-dim)", fontSize: "0.78rem" }}>
            Connector Monitor · sign in
          </div>
        </div>

        {!challengeId ? (
          <>
            <div style={inputRowStyle}>
              <label htmlFor="login-email" style={labelStyle}>
                Email
              </label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={fieldStyle}
              />
            </div>
            <div style={inputRowStyle}>
              <label htmlFor="login-password" style={labelStyle}>
                Password
              </label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={fieldStyle}
              />
            </div>
          </>
        ) : (
          <div style={inputRowStyle}>
            <label htmlFor="login-code" style={labelStyle}>
              2FA code
            </label>
            <input
              id="login-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={fieldStyle}
            />
          </div>
        )}

        {error && <div style={errorStyle} role="alert">{error}</div>}

        <button
          type="submit"
          disabled={submitting}
          style={{
            width: "100%",
            marginTop: "0.6rem",
            font: "inherit",
            fontWeight: 600,
            fontSize: "0.82rem",
            padding: "0.5rem 0.6rem",
            border: "1px solid var(--line-cobalt)",
            borderRadius: "var(--radius)",
            background: "var(--line-cobalt)",
            color: "#fff",
            cursor: submitting ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? "Please wait…" : challengeId ? "Verify & sign in" : "Continue"}
        </button>
      </form>
    </div>
  );
}