/* Synthetic demonstration fixtures for the Amber Pay monitor redesign.
   These stand in for live API data on surfaces that have no endpoint yet
   (users, system config, profile) or when the backend is not reachable.

   SYNTHETIC — every value here is illustrative. They carry NO financial
   amounts, NO customer PII, and NO ledger figures (FR-2.3 / FR-5.2); emails
   are auth-entity fields only, and names are omitted in favour of role labels.
   Anything a visitor could mistake for a real record is labelled Demo. */

import {
  CONNECTORS,
  EVENTS,
  FAILURES,
} from "@/types/domain";
import type { PolicyScope } from "@/types/domain";
import type { ApiServiceStatus, ApiStageFlowSummary } from "@/types/api";
import type { MappedMetrics } from "@/services/map.service";

/** Demo policies spanning the PBAC range, so navigation gating is observable. */export const DEMO_POLICIES: PolicyScope[] = [
  {
    id: "super-admin",
    label: "Super Admin",
    attributes: "scope:*|organizationId:*|actions:read,ack,write,admin",
    readOnly: false,
  },
  {
    id: "ops-monitor",
    label: "Ops Monitor",
    attributes: "scope:dashboard|organizationId:acme|actions:read,ack",
    readOnly: false,
  },
  {
    id: "audit",
    label: "Audit · read-only",
    attributes: "scope:dashboard|organizationId:acme|actions:read",
    readOnly: true,
  },
];

export function demoMetrics(): MappedMetrics {
  return {
    connectors: CONNECTORS,
    events: EVENTS,
    failures: FAILURES,
    policies: DEMO_POLICIES,
    stages: demoStages(),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Synthetic stage aggregate for demo mode.
 *
 * Built to tell the SAME story as the demo findings, because a demo whose
 * spine says "healthy" while its findings say "webhook processing error" is
 * worse than no demo at all — it teaches the wrong reading. Thresholds mirror
 * the backend's own, and ages are relative to now so "oldest 47m" stays live.
 */
export function demoStages(): ApiStageFlowSummary {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;

  return {
    stages: [
      {
        stage: "initiated",
        state: "healthy",
        entered: 128,
        inFlight: 2,
        exited: 126,
        completed: 0,
        failed: 0,
        oldestInFlightAt: ago(95_000),
        dwellP95Ms: 1_100,
        sampleSize: 126,
        thresholds: { warnMs: 30_000, failMs: 300_000 },
        notReporting: false,
      },
      {
        stage: "collected",
        state: "healthy",
        entered: 125,
        inFlight: 1,
        exited: 124,
        completed: 0,
        failed: 0,
        oldestInFlightAt: ago(41_000),
        dwellP95Ms: 8_400,
        sampleSize: 124,
        thresholds: { warnMs: 60_000, failMs: 600_000 },
        notReporting: false,
      },
      {
        stage: "ingested",
        state: "failed",
        entered: 124,
        inFlight: 6,
        exited: 117,
        completed: 0,
        failed: 1,
        oldestInFlightAt: ago(47 * MIN),
        dwellP95Ms: 121_000,
        sampleSize: 117,
        thresholds: { warnMs: 60_000, failMs: 600_000 },
        notReporting: false,
      },
      {
        stage: "posted",
        state: "degraded",
        entered: 117,
        inFlight: 0,
        exited: 0,
        completed: 117,
        failed: 0,
        oldestInFlightAt: null,
        dwellP95Ms: 6_700,
        sampleSize: 117,
        thresholds: { warnMs: 5_000, failMs: 30_000 },
        notReporting: false,
      },
    ],
    trackedRefs: 128,
    oldestInFlightAt: ago(47 * MIN),
    failedRefs: 1,
    window: { from: ago(60 * MIN), to: ago(0) },
    eventsConsidered: EVENTS.length,
    mayBeTruncated: false,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Synthetic backend service status for demo mode.
 *
 * Without this the service window would only ever render its "no status"
 * state in demo, so the panel that answers "is this console actually seeing
 * anything?" would never be demonstrated. The adaptor list matches the demo
 * narrative: Sage unreachable, which is what the Ingested stage is failing on.
 */
export function demoService(): ApiServiceStatus {
  const now = Date.now();
  const startedAt = new Date(now - 3 * 3600_000 - 12 * 60_000).toISOString();
  return {
    service: {
      name: "amber-pay-monitor",
      version: "2.4.1",
      environment: "demo",
      nodeVersion: "v20.11.1",
      startedAt,
      uptimeSeconds: Math.round((now - new Date(startedAt).getTime()) / 1000),
      storage: "postgres",
      eventWindowLimit: 500,
      rows: { connectors: CONNECTORS.length, failures: FAILURES.length },
      adaptors: [
        {
          id: "quickbooks",
          name: "QuickBooks Online",
          status: "connected",
          reachable: true,
          latencyMs: 42,
        },
        {
          id: "sage",
          name: "Sage",
          status: "error",
          reachable: false,
          latencyMs: null,
          message: "unreachable · webhook endpoint returned 502",
        },
      ],
    },
    generatedAt: new Date().toISOString(),
  };
}

export interface DemoUser {
  id: string;
  email: string;
  scope: string;
  organizationId: string;
  actions: string;
  status: "active" | "invite pending";
  invitedFor: string;
  lastSeen: string;
}

export const DEMO_USERS: DemoUser[] = [
  {
    id: "u-8012",
    email: "ops-team@amber.demo",
    scope: "dashboard",
    organizationId: "acme",
    actions: "read, ack",
    status: "active",
    invitedFor: "Connector monitor",
    lastSeen: "14:02 today",
  },
  {
    id: "u-8033",
    email: "accounting@amber.demo",
    scope: "payments",
    organizationId: "acme",
    actions: "read, write",
    status: "active",
    invitedFor: "Payment operations",
    lastSeen: "13:40 today",
  },
  {
    id: "u-8061",
    email: "compliance@amber.demo",
    scope: "dashboard",
    organizationId: "acme",
    actions: "read",
    status: "active",
    invitedFor: "Audit trail",
    lastSeen: "09:18 today",
  },
  {
    id: "u-8090",
    email: "reviewer@amber.demo",
    scope: "system",
    organizationId: "*",
    actions: "read, write, admin",
    status: "invite pending",
    invitedFor: "System configuration",
    lastSeen: "—",
  },
];

export interface AdaptorConfig {
  id: string;
  name: string;
  kind: "push" | "pull";
  connectorId: "push" | "pull" | "sage" | "events";
  enabled: boolean;
  endpoint: string;
  syncInterval: string;
}

export const DEMO_CONFIG: AdaptorConfig[] = [
  {
    id: "ad-qb-push",
    name: "QuickBooks Online · push",
    kind: "push",
    connectorId: "push",
    enabled: true,
    endpoint: "https://api.quickbooks.demo/v3/company/…",
    syncInterval: "—",
  },
  {
    id: "ad-sage",
    name: "Sage bridge",
    kind: "push",
    connectorId: "sage",
    enabled: true,
    endpoint: "https://api.sage.demo/v3.1/…",
    syncInterval: "—",
  },
  {
    id: "ad-qb-pull",
    name: "QuickBooks Online · reconciliation pull",
    kind: "pull",
    connectorId: "pull",
    enabled: true,
    endpoint: "https://api.quickbooks.demo/v3/company/…",
    syncInterval: "15 min",
  },
];

export const DEMO_WEBHOOK = {
  target: "https://events.amber.demo/webhooks/payments",
  retainForDays: 7,
  alertTarget: "on-call queue · PagerDuty",
};

export const DEMO_RECON = {
  status: "running",
  matched: 1284,
  unmatched: 3,
  anomalies: 2,
  ranAt: new Date().toISOString(),
};